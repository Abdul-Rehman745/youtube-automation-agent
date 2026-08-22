const crypto = require('crypto');
const { Logger } = require('./logger');
const { SceneRetentionEngine } = require('./scene-retention-engine');

class ChannelLearningEngine {
  constructor(db) {
    this.db = db;
    this.logger = new Logger('ChannelLearning');
    this.sceneRetention = new SceneRetentionEngine(db);
  }

  async capture(performanceReport, context = {}, measurementWindow = 'rolling') {
    const metrics = this.normalizeMetrics(performanceReport);
    const attributes = this.extractAttributes(performanceReport, context);
    const prior = (await this.db.listPerformanceSnapshots({
      measurementWindow,
      reliableOnly: true,
      excludeVideoId: performanceReport.videoId
    })).filter(snapshot => (snapshot.contentAttributes?.surface || 'long_form') === attributes.surface);
    const baseline = this.calculateBaseline(prior);
    const simulated = Boolean(performanceReport.analytics?.simulated);
    const confidence = simulated ? 'unverified' : this.confidenceFor(metrics);
    const snapshot = await this.db.savePerformanceSnapshot({
      videoId: performanceReport.videoId,
      productionId: context.productionId || null,
      measurementWindow,
      publishedAt: performanceReport.videoDetails?.publishedAt || context.publishedAt || null,
      metrics,
      contentAttributes: attributes,
      baseline,
      deltas: this.calculateDeltas(metrics, baseline),
      confidence,
      simulated
    });

    if (simulated) {
      this.logger.warn(`Excluded simulated analytics for ${performanceReport.videoId} from channel learning`);
      return snapshot;
    }

    await this.refreshRecommendations();
    return snapshot;
  }

  normalizeMetrics(report) {
    const analytics = report.analytics || {};
    const views = analytics.views || {};
    const watchTime = analytics.watchTime || {};
    const engagement = analytics.engagement || {};
    return {
      views: this.number(views.totalViews),
      impressions: this.number(views.totalImpressions || report.thumbnailMetrics?.impressions),
      ctr: this.number(report.thumbnailMetrics?.clickThroughRate ?? views.averageCTR),
      retention: this.number(watchTime.averageViewPercentage),
      averageViewDuration: this.number(watchTime.averageViewDuration),
      watchMinutes: this.number(watchTime.totalWatchTime),
      engagementRate: this.number(engagement.engagementRate),
      performanceScore: this.number(report.performance?.score)
    };
  }

  extractAttributes(report, context) {
    const strategy = context.strategy || {};
    const script = context.script || {};
    const thumbnail = context.thumbnail || {};
    const title = report.videoDetails?.title || context.title || script.title || '';
    const hook = this.text(script.hook || script.introduction || '');
    return {
      topic: strategy.topic || '',
      surface: context.contentFormat === 'short' ? 'shorts' : 'long_form',
      format: context.contentFormat === 'short'
        ? 'shorts'
        : this.slug(strategy.requestedStyle || strategy.contentType || 'unknown'),
      length: this.slug(strategy.requestedLengthKey || strategy.requestedLength || 'unknown'),
      hookLength: hook ? (this.wordCount(hook) <= 40 ? 'concise' : 'extended') : 'unknown',
      titleLength: title ? (this.wordCount(title) <= 9 ? 'concise' : 'long') : 'unknown',
      thumbnailStyle: this.slug(
        thumbnail.concept?.composition || thumbnail.concept?.style || thumbnail.style || 'unknown'
      ),
      source: strategy.planRationale ? 'autonomous_operator' : 'manual'
    };
  }

  calculateBaseline(snapshots) {
    const keys = ['views', 'impressions', 'ctr', 'retention', 'averageViewDuration', 'watchMinutes', 'engagementRate', 'performanceScore'];
    return Object.fromEntries(keys.map(key => [key, this.median(
      snapshots.map(snapshot => this.number(snapshot.metrics?.[key])).filter(value => Number.isFinite(value))
    )]));
  }

  calculateDeltas(metrics, baseline) {
    return Object.fromEntries(Object.entries(metrics).map(([key, value]) => {
      const reference = this.number(baseline[key]);
      return [key, reference > 0 ? Number((((value - reference) / reference) * 100).toFixed(1)) : null];
    }));
  }

  confidenceFor(metrics) {
    if (metrics.impressions >= 1000 && metrics.views >= 100) return 'high';
    if (metrics.impressions >= 100 && metrics.views >= 20) return 'medium';
    return 'low';
  }

  async refreshRecommendations() {
    const all = await this.db.listPerformanceSnapshots({ reliableOnly: true });
    const snapshots = this.preferredSnapshotPerVideo(all);
    if (snapshots.length < 2) return [];

    const candidates = [
      ...this.buildDimensionRecommendations(snapshots),
      ...this.buildChannelRecommendations(snapshots)
    ];
    const saved = [];
    for (const candidate of candidates) {
      saved.push(await this.db.saveLearningRecommendation({
        ...candidate,
        fingerprint: this.fingerprint(candidate)
      }));
    }
    return saved;
  }

  preferredSnapshotPerVideo(snapshots) {
    const rank = { '7d': 3, '24h': 2, rolling: 1 };
    const selected = new Map();
    for (const snapshot of snapshots) {
      const current = selected.get(snapshot.videoId);
      if (!current || (rank[snapshot.measurementWindow] || 0) > (rank[current.measurementWindow] || 0)) {
        selected.set(snapshot.videoId, snapshot);
      }
    }
    return [...selected.values()];
  }

  buildDimensionRecommendations(snapshots) {
    const dimensions = [
      { key: 'format', metric: 'performanceScore', label: 'format', minimumDifference: 10 },
      { key: 'length', metric: 'retention', label: 'video length', minimumDifference: 8 },
      { key: 'hookLength', metric: 'retention', label: 'hook style', minimumDifference: 8 },
      { key: 'titleLength', metric: 'ctr', label: 'title style', minimumDifference: 1.25 }
    ];
    const recommendations = [];

    for (const dimension of dimensions) {
      const groups = new Map();
      for (const snapshot of snapshots) {
        const value = snapshot.contentAttributes?.[dimension.key];
        const metric = this.number(snapshot.metrics?.[dimension.metric]);
        if (!value || value === 'unknown' || !Number.isFinite(metric)) continue;
        if (!groups.has(value)) groups.set(value, []);
        groups.get(value).push(metric);
      }
      const ranked = [...groups.entries()]
        .filter(([, values]) => values.length >= 2)
        .map(([value, values]) => ({ value, count: values.length, average: this.average(values) }))
        .sort((a, b) => b.average - a.average);
      if (ranked.length < 2 || ranked[0].average - ranked.at(-1).average < dimension.minimumDifference) continue;

      const best = ranked[0];
      const weakest = ranked.at(-1);
      const metricLabel = dimension.metric === 'ctr' ? 'CTR' : dimension.metric === 'retention' ? 'retention' : 'performance score';
      recommendations.push({
        category: dimension.key,
        title: `Favor ${this.readable(best.value)} over ${this.readable(weakest.value)} ${dimension.label}`,
        rationale: `${this.readable(best.value)} ${dimension.label} averaged ${this.metric(best.average, dimension.metric)} ${metricLabel} across ${best.count} videos versus ${this.metric(weakest.average, dimension.metric)} across ${weakest.count}.`,
        evidence: { dimension: dimension.key, metric: dimension.metric, best, weakest },
        proposedChange: { target: 'future_plans', dimension: dimension.key, prefer: best.value, deprioritize: weakest.value },
        confidence: best.count >= 4 && weakest.count >= 4 ? 'high' : 'medium'
      });
    }
    return recommendations;
  }

  buildChannelRecommendations(snapshots) {
    const sufficientlyExposed = snapshots.filter(snapshot => this.number(snapshot.metrics?.impressions) >= 100);
    if (sufficientlyExposed.length < 2) return [];
    const averageCTR = this.average(sufficientlyExposed.map(item => this.number(item.metrics.ctr)));
    const averageRetention = this.average(sufficientlyExposed.map(item => this.number(item.metrics.retention)));
    const recommendations = [];

    if (averageCTR < 4) {
      recommendations.push({
        category: 'packaging',
        title: 'Test new title and thumbnail packaging',
        rationale: `Channel CTR averaged ${averageCTR.toFixed(1)}% across ${sufficientlyExposed.length} sufficiently exposed videos.`,
        evidence: { metric: 'ctr', average: averageCTR, sampleSize: sufficientlyExposed.length, minimumImpressions: 100 },
        proposedChange: { target: 'review', experiment: 'title_thumbnail_variant' },
        confidence: sufficientlyExposed.length >= 5 ? 'high' : 'medium'
      });
    }
    if (averageRetention < 35) {
      recommendations.push({
        category: 'retention',
        title: 'Tighten hooks and early pacing',
        rationale: `Average view percentage was ${averageRetention.toFixed(1)}% across ${sufficientlyExposed.length} sufficiently exposed videos.`,
        evidence: { metric: 'retention', average: averageRetention, sampleSize: sufficientlyExposed.length },
        proposedChange: { target: 'future_scripts', prefer: 'concise_hook_and_faster_opening' },
        confidence: sufficientlyExposed.length >= 5 ? 'high' : 'medium'
      });
    }
    return recommendations;
  }

  async getSummary() {
    const [snapshots, recommendations, retentionSnapshots] = await Promise.all([
      this.db.listPerformanceSnapshots({ reliableOnly: true }),
      this.db.listLearningRecommendations({ limit: 50 }),
      this.db.listRetentionSnapshots ? this.db.listRetentionSnapshots({ limit: 12 }) : Promise.resolve([])
    ]);
    const preferred = this.preferredSnapshotPerVideo(snapshots);
    return {
      measuredVideos: preferred.length,
      snapshotCount: snapshots.length,
      baseline: this.calculateBaseline(preferred),
      windows: snapshots.reduce((counts, snapshot) => {
        counts[snapshot.measurementWindow] = (counts[snapshot.measurementWindow] || 0) + 1;
        return counts;
      }, {}),
      recommendations,
      approvedCount: recommendations.filter(item => item.status === 'approved').length,
      pendingCount: recommendations.filter(item => item.status === 'pending').length,
      lastMeasuredAt: snapshots[0]?.measuredAt || null,
      evidencePolicy: 'Only real YouTube analytics are eligible; simulated fallbacks are excluded.',
      retention: {
        snapshotCount: retentionSnapshots.length,
        longFormCount: retentionSnapshots.filter(item => item.surface === 'long_form').length,
        shortsCount: retentionSnapshots.filter(item => item.surface === 'shorts').length,
        snapshots: retentionSnapshots
      }
    };
  }

  captureRetention(retentionReport, context = {}, measurementWindow = 'rolling', exposure = {}) {
    return this.sceneRetention.capture(retentionReport, context, measurementWindow, exposure);
  }

  async getDueMeasurementWindows(video) {
    const published = new Date(video.published_at || video.publishedAt);
    if (Number.isNaN(published.getTime())) return [];
    const ageHours = (Date.now() - published.getTime()) / 3600000;
    const existing = await this.db.listPerformanceSnapshots({
      videoId: video.youtube_id || video.youtubeId,
      reliableOnly: true
    });
    const windows = new Set(existing.map(item => item.measurementWindow));
    return [
      ...(ageHours >= 24 && !windows.has('24h') ? ['24h'] : []),
      ...(ageHours >= 168 && !windows.has('7d') ? ['7d'] : [])
    ];
  }

  measurementPeriod(publishedAt, measurementWindow) {
    if (!['24h', '7d'].includes(measurementWindow) || !publishedAt) return null;
    const start = new Date(publishedAt);
    if (Number.isNaN(start.getTime())) return null;
    const days = measurementWindow === '24h' ? 1 : 7;
    const end = new Date(Math.min(Date.now(), start.getTime() + days * 86400000));
    return { startDate: this.date(start), endDate: this.date(end) };
  }

  fingerprint(candidate) {
    const identity = {
      category: candidate.category,
      title: candidate.title,
      proposedChange: candidate.proposedChange
    };
    return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }

  median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  metric(value, metric) {
    return metric === 'performanceScore' ? value.toFixed(0) : `${value.toFixed(1)}%`;
  }

  number(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  text(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => this.text(item)).join(' ');
    if (value && typeof value === 'object') return Object.values(value).map(item => this.text(item)).join(' ');
    return '';
  }

  wordCount(value) {
    return String(value).trim().split(/\s+/).filter(Boolean).length;
  }

  slug(value) {
    return String(value || 'unknown').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unknown';
  }

  readable(value) {
    return String(value).replaceAll('_', ' ');
  }

  date(value) {
    return value.toISOString().slice(0, 10);
  }
}

module.exports = { ChannelLearningEngine };
