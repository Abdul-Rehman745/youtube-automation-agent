const crypto = require('crypto');
const { Logger } = require('./logger');

const FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const COMMENT_FLAGS = ['question', 'request', 'praise', 'correction', 'spam', 'scam', 'toxic'];
const QUARANTINE_FLAGS = ['spam', 'scam', 'toxic'];
const THEME_KINDS = ['question', 'request', 'feedback', 'correction', 'praise'];

class AudienceEngagementService {
  constructor(db, credentials, aiTextService, options = {}) {
    this.db = db;
    this.credentials = credentials;
    this.aiTextService = aiTextService;
    this.logger = options.logger || new Logger('AudienceEngagement');
    this.maxCommentsPerSync = Number(options.maxCommentsPerSync || 500);
    this.maxCommentsPerAnalysis = Number(options.maxCommentsPerAnalysis || 200);
    this.maxDraftsPerRun = Number(options.maxDraftsPerRun || 10);
    this.dailyReplyCap = Number(options.dailyReplyCap || process.env.ENGAGEMENT_DAILY_REPLY_CAP || 50);
    this.listCommentThreads = options.listCommentThreads || (params => this.defaultListCommentThreads(params));
    this.insertComment = options.insertComment || (params => this.defaultInsertComment(params));
    this.getChannelId = options.getChannelId || (() => this.defaultGetChannelId());
    this.channelId = null;
  }

  async defaultListCommentThreads({ videoId, pageToken }) {
    const youtube = this.credentials.getYouTubeClient();
    const response = await youtube.commentThreads.list({
      part: ['snippet', 'replies'],
      videoId,
      order: 'time',
      maxResults: 100,
      ...(pageToken ? { pageToken } : {})
    });
    return response.data;
  }

  async defaultInsertComment({ parentId, text }) {
    const youtube = this.credentials.getYouTubeClient();
    const response = await youtube.comments.insert({
      part: ['snippet'],
      requestBody: { snippet: { parentId, textOriginal: text } }
    });
    return { id: response.data?.id };
  }

  async defaultGetChannelId() {
    const youtube = this.credentials.getYouTubeClient();
    const response = await youtube.channels.list({ part: ['id'], mine: true });
    return response.data?.items?.[0]?.id || null;
  }

  async resolveChannelId() {
    if (this.channelId) return this.channelId;
    try {
      this.channelId = await this.getChannelId();
    } catch (error) {
      this.logger.warn(`Channel id lookup failed; owner detection disabled: ${error.message}`);
      this.channelId = null;
    }
    return this.channelId;
  }

  permalink(videoId, commentId) {
    return `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`;
  }

  isSyncDue(insight, publishedAt, now = new Date()) {
    if (!insight?.lastSyncedAt) return true;
    const published = publishedAt ? new Date(publishedAt) : null;
    if (!published || Number.isNaN(published.getTime())) return false;
    const ageHours = (now - published) / 3600000;
    if (ageHours > 24 * 30) return false;
    const staleHours = (now - new Date(insight.lastSyncedAt)) / 3600000;
    if (ageHours <= 48) return staleHours >= 4;
    if (ageHours <= 24 * 7) return staleHours >= 12;
    return staleHours >= 24;
  }

  mapThread(item, videoId, channelId) {
    const top = item.snippet?.topLevelComment;
    const topSnippet = top?.snippet || {};
    const comments = [{
      commentId: top?.id || item.id,
      videoId,
      parentCommentId: null,
      authorName: topSnippet.authorDisplayName || null,
      authorChannelId: topSnippet.authorChannelId?.value || null,
      isChannelOwner: Boolean(channelId && topSnippet.authorChannelId?.value === channelId),
      text: topSnippet.textOriginal || topSnippet.textDisplay || '',
      likeCount: Number(topSnippet.likeCount || 0),
      replyCount: Number(item.snippet?.totalReplyCount || 0),
      publishedAt: topSnippet.publishedAt || null,
      updatedAtYouTube: topSnippet.updatedAt || null
    }];
    for (const reply of item.replies?.comments || []) {
      const snippet = reply.snippet || {};
      comments.push({
        commentId: reply.id,
        videoId,
        parentCommentId: top?.id || item.id,
        authorName: snippet.authorDisplayName || null,
        authorChannelId: snippet.authorChannelId?.value || null,
        isChannelOwner: Boolean(channelId && snippet.authorChannelId?.value === channelId),
        text: snippet.textOriginal || snippet.textDisplay || '',
        likeCount: Number(snippet.likeCount || 0),
        replyCount: 0,
        publishedAt: snippet.publishedAt || null,
        updatedAtYouTube: snippet.updatedAt || null
      });
    }
    return comments.filter(comment => comment.commentId && comment.text);
  }

  // Watermark is keyed on top-level publish time (order=time is newest-first);
  // new replies inside old threads are only picked up when their thread re-enters a page.
  async syncVideoComments(videoId, meta = {}) {
    const existing = await this.db.getEngagementInsight(videoId);
    const watermark = existing?.newestCommentAt ? new Date(existing.newestCommentAt) : null;
    const channelId = await this.resolveChannelId();
    let pageToken;
    let fetched = 0;
    let newest = watermark;
    let reachedWatermark = false;
    let disabled = false;

    try {
      do {
        const page = await this.listCommentThreads({ videoId, pageToken });
        for (const item of page.items || []) {
          const threadComments = this.mapThread(item, videoId, channelId);
          const topPublished = threadComments[0]?.publishedAt ? new Date(threadComments[0].publishedAt) : null;
          if (watermark && topPublished && topPublished <= watermark) {
            reachedWatermark = true;
            break;
          }
          for (const comment of threadComments) {
            await this.db.upsertAudienceComment(comment);
            fetched++;
            const published = comment.publishedAt ? new Date(comment.publishedAt) : null;
            if (published && (!newest || published > newest)) newest = published;
          }
        }
        pageToken = reachedWatermark ? null : page.nextPageToken || null;
      } while (pageToken && fetched < this.maxCommentsPerSync);
    } catch (error) {
      if (error?.errors?.[0]?.reason === 'commentsDisabled') {
        disabled = true;
      } else {
        // Refusal policy: a failed sync records nothing — there is no simulated comment.
        throw error;
      }
    }

    const counts = await this.db.countAudienceComments(videoId);
    const insight = await this.db.saveEngagementInsight({
      videoId,
      productionId: meta.productionId || existing?.productionId || null,
      title: meta.title || existing?.title || null,
      commentCount: counts.total,
      lastSyncedAt: new Date().toISOString(),
      newestCommentAt: newest ? newest.toISOString() : existing?.newestCommentAt || null
    });
    return { videoId, fetched, disabled, insight };
  }
}

module.exports = { AudienceEngagementService };
