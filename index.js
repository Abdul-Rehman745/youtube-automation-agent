require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const { OperatorService } = require('./utils/operator-service');
const { ActivationMetrics } = require('./utils/activation-metrics');
const { AnonymousTelemetry } = require('./utils/anonymous-telemetry');
const { version } = require('./package.json');
const chalk = require('chalk');

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
    this.activeJobs = new Map();
    this.operator = null;
    this.activation = null;
    this.telemetry = null;
    this.setupRequired = false;
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold(`\n🎬 YouTube Automation Agent v${version}`));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      await this.db.markInterruptedJobs();
      this.operator = new OperatorService(this.db);
      this.activation = new ActivationMetrics(this.db);
      this.telemetry = new AnonymousTelemetry(this.db, this.logger);
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      const credentialsValid = await this.credentials.validateAll();
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        this.setupRequired = true;
        this.setupAPI();
        this.isInitialized = true;
        this.logger.warn('Dashboard started in setup mode; generation and publishing are disabled');
        return true;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();

      // Show which pipeline stages will run for real vs. be simulated
      const capabilities = await this.logCapabilitySummary();
      if (capabilities.hasText && capabilities.hasFFmpeg && capabilities.hasUpload) {
        await this.activation.markSetupReady(capabilities);
      }
      
      // Setup API endpoints
      this.setupAPI();
      
      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db, {
        generateContent: input => this.startGenerationJob(input)
      });
      await this.scheduler.initialize();

      if (await this.db.getSetting('automation_paused') === 'true') {
        await this.scheduler.pauseAutomation();
      }
      
      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');
      
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials)
    };

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }
  }

  async logCapabilitySummary() {
    const { checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');
    const creds = this.credentials.credentials || {};

    const hasText = this.credentials.hasAITextProvider();
    const hasGemini = Boolean(creds.gemini?.apiKey || process.env.GEMINI_API_KEY);
    const hasImages = Boolean(creds.openai?.apiKey || process.env.OPENAI_API_KEY || hasGemini);
    const hasTTS = Boolean(
      creds.openai?.apiKey || process.env.OPENAI_API_KEY ||
      creds.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY ||
      creds.azureSpeech?.subscriptionKey || process.env.AZURE_SPEECH_KEY ||
      hasGemini
    );
    const hasFFmpeg = await checkFFmpeg();
    const hasUpload = Boolean(creds.youtube && this.credentials.tokens?.youtube);

    const capabilities = [
      { name: 'Script & strategy generation', ok: hasText, hint: 'configure an AI provider (npm run credentials:setup)' },
      { name: 'Image generation (visuals/thumbnails)', ok: hasImages, hint: 'requires an OpenAI or Gemini API key — otherwise gradient slides are used' },
      { name: 'Voice narration (TTS)', ok: hasTTS, hint: 'configure OpenAI, Gemini, ElevenLabs, or Azure Speech — otherwise videos are silent' },
      { name: 'Video assembly (FFmpeg)', ok: hasFFmpeg, hint: ffmpegInstallHint() },
      { name: 'YouTube upload', ok: hasUpload, hint: 'run: npm run credentials:setup' }
    ];

    console.log(chalk.cyan('\n🔎 Capability check:'));
    for (const cap of capabilities) {
      if (cap.ok) {
        console.log(chalk.green(`  ✓ ${cap.name}`));
      } else {
        console.log(chalk.yellow(`  ✗ ${cap.name} — ${cap.hint}`));
      }
    }

    if (!hasFFmpeg) {
      this.logger.warn('FFmpeg is missing: no .mp4 files can be produced until it is installed.');
    }
    console.log('');
    return { hasText, hasImages, hasTTS, hasFFmpeg, hasUpload };
  }

  requireAPIKey() {
    return (req, res, next) => {
      if (!process.env.API_KEY) {
        return next();
      }

      if (req.get('x-api-key') !== process.env.API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      return next();
    };
  }

  validateGenerateRequestBody(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { valid: false, status: 400, error: 'Request body must be a JSON object' };
    }

    const value = {
      topic: null,
      style: null,
      length: typeof body.length === 'string' ? body.length.toLowerCase() : 'medium'
    };

    // JSON has no `undefined`, so clients send `null` to mean "no value provided".
    // Both are treated as "not set" here: topic/style are optional and default to
    // auto-selection, which is exactly what `null` already represents internally.
    if (body.topic !== undefined && body.topic !== null) {
      if (typeof body.topic !== 'string') {
        return { valid: false, status: 400, error: 'topic must be a string' };
      }

      const topic = body.topic.trim();
      if (topic.length > 200) {
        return { valid: false, status: 400, error: 'topic must be 200 characters or less' };
      }
      value.topic = topic || null;
    }

    if (body.style !== undefined && body.style !== null) {
      if (typeof body.style !== 'string') {
        return { valid: false, status: 400, error: 'style must be a string' };
      }

      const allowedStyles = new Set([
        'tutorial',
        'explainer',
        'list',
        'review',
        'story',
        'educational',
        'informative',
        'engaging',
        'professional',
        'ethereal'
      ]);
      const style = body.style.trim();

      if (style.length > 50) {
        return { valid: false, status: 400, error: 'style must be 50 characters or less' };
      }

      value.style = allowedStyles.has(style.toLowerCase()) ? style.toLowerCase() : style || null;
    }

    if (!['short', 'medium', 'long'].includes(value.length)) {
      return { valid: false, status: 400, error: 'length must be short, medium, or long' };
    }

    return { valid: true, value };
  }
  setupAPI() {
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.static(path.join(__dirname, 'dashboard')));

    if (!process.env.API_KEY) {
      this.logger.warn('API_KEY is not set; mutating API routes are unprotected');
    }
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: this.setupRequired ? 'setup_required' : 'healthy',
        initialized: this.isInitialized,
        setupRequired: this.setupRequired,
        agents: Object.keys(this.agents),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    // Manual content generation
    this.app.post('/generate', this.requireAPIKey(), async (req, res) => {
      try {
        if (this.setupRequired) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before generating content' });
        }
        const validation = this.validateGenerateRequestBody(req.body);
        if (!validation.valid) {
          return res.status(validation.status).json({ success: false, error: validation.error });
        }

        const { topic, style, length } = validation.value;
        const result = await this.startGenerationJob({ topic, style, length, source: 'manual' });
        res.status(202).json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        if (!this.agents.analytics) return res.json({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] });
        const analytics = await this.agents.analytics.getRecentAnalytics();
        res.json(analytics);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', this.requireAPIKey(), async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ success: false, error: 'YouTube publishing is not configured' });
        const { contentId } = req.params;
        const bundle = await this.db.getProductionBundle(contentId);
        if (!bundle || bundle.review_status !== 'approved') {
          return res.status(409).json({ success: false, error: 'Content must pass review and be approved before publishing' });
        }
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.setupOperatorAPI();
  }

  setupOperatorAPI() {
    const protect = this.requireAPIKey();

    this.app.get('/api/dashboard', async (_req, res) => {
      try {
        const [stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, activation] = await Promise.all([
          this.db.getStats(),
          this.db.listGenerationJobs(20),
          this.db.getPipelineOverview(50),
          this.db.getUpcomingSchedule(30),
          this.db.getRecentAutomationEvents(20),
          this.db.listNotifications(20),
          this.db.getChannelProfile(),
          this.db.getAllSettings(),
          this.db.listContentIdeas(),
          this.agents.analytics
            ? this.agents.analytics.getRecentAnalytics(30)
            : Promise.resolve({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] }),
          this.activation
            ? this.activation.getSummary()
            : Promise.resolve({ privacy: 'local-only', counts: {}, milestones: {} })
        ]);
        if (this.telemetry) void this.telemetry.sync(activation);
        res.json({
          stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, activation,
          system: {
            initialized: this.isInitialized,
            setupRequired: this.setupRequired,
            uptime: process.uptime(),
            activeJobs: this.activeJobs.size,
            automationPaused: this.scheduler ? !this.scheduler.isEnabled : true,
            agents: Object.keys(this.agents)
          }
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/jobs/:jobId', async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      return res.json(job);
    });

    this.app.post('/api/jobs/:jobId/cancel', protect, async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (!['queued', 'running'].includes(job.status)) {
        return res.status(409).json({ error: 'Only queued or running jobs can be cancelled' });
      }
      const updated = await this.db.updateGenerationJob(job.id, { cancelRequested: true, details: { cancelReason: req.body?.reason || 'Cancelled by operator' } });
      return res.json({ success: true, result: updated });
    });

    this.app.get('/api/content/:productionId', async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      return res.json(this.decorateContentBundle(bundle));
    });

    this.app.patch('/api/content/:productionId', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' && bundle.schedule?.status === 'published') {
          return res.status(409).json({ error: 'Published content cannot be edited here' });
        }
        const editorData = this.validateEditorData(req.body, bundle.editorData);
        const result = await this.db.saveContentReview(bundle.id, {
          status: bundle.review_status || 'needs_review',
          editorData,
          qualityChecks: bundle.qualityChecks,
          reviewNotes: req.body.reviewNotes ?? bundle.review_notes,
          reviewedAt: bundle.reviewed_at
        });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/content/:productionId/approve', protect, async (req, res) => {
      try {
        const result = await this.approveContent(req.params.productionId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, quality: error.quality });
      }
    });

    this.app.post('/api/content/:productionId/reject', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      await this.db.saveContentReview(bundle.id, {
        status: 'rejected',
        editorData: bundle.editorData,
        qualityChecks: bundle.qualityChecks,
        reviewNotes: req.body?.notes || 'Rejected by operator',
        reviewedAt: new Date().toISOString()
      });
      await this.db.updateProductionStatus(bundle.id, 'rejected');
      return res.json({ success: true });
    });

    this.app.post('/api/content/:productionId/retry', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      const job = await this.startGenerationJob({
        topic: bundle.strategy.topic || bundle.editorData.title || null,
        style: bundle.strategy.requestedStyle || bundle.strategy.contentType || null,
        length: bundle.strategy.requestedLengthKey || 'medium',
        source: 'retry'
      });
      return res.status(202).json({ success: true, result: job });
    });

    this.app.get('/api/content/:productionId/asset/:kind', async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        const allowed = {
          video: bundle.assets?.finalVideo?.path,
          thumbnail: bundle.assets?.thumbnail?.path,
          captions: bundle.assets?.captions?.path,
          script: bundle.assets?.script?.originalPath
        };
        const filePath = allowed[req.params.kind];
        if (!filePath) return res.status(404).json({ error: 'Asset not found' });
        const resolved = path.resolve(filePath);
        const dataRoot = path.resolve(__dirname, 'data');
        if (!resolved.startsWith(`${dataRoot}${path.sep}`)) return res.status(403).json({ error: 'Asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Asset not found' });
      }
    });

    this.app.put('/api/profile', protect, async (req, res) => {
      try {
        const profile = this.validateProfile(req.body || {});
        return res.json({ success: true, result: await this.db.saveChannelProfile(profile) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/ideas', protect, async (req, res) => {
      const topic = String(req.body?.topic || '').trim();
      if (!topic || topic.length > 200) return res.status(400).json({ error: 'A topic of 200 characters or less is required' });
      const idea = await this.db.createContentIdea({ ...req.body, topic });
      return res.status(201).json({ success: true, result: idea });
    });

    this.app.patch('/api/ideas/:ideaId', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, req.body || {});
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      return res.json({ success: true, result: idea });
    });

    this.app.post('/api/ideas/:ideaId/generate', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, { status: 'generating' });
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      const job = await this.startGenerationJob({ topic: idea.topic, style: idea.style, length: req.body?.length || 'medium', source: 'idea' });
      await this.db.updateContentIdea(idea.id, { status: 'generated' });
      return res.status(202).json({ success: true, result: job });
    });

    this.app.post('/api/automation/:action', protect, async (req, res) => {
      if (!this.scheduler) return res.status(409).json({ error: 'Finish setup before controlling automation' });
      const { action } = req.params;
      if (action === 'pause') {
        await this.scheduler.pauseAutomation();
        await this.db.setSetting('automation_paused', 'true');
      } else if (action === 'resume') {
        await this.scheduler.resumeAutomation();
        await this.db.setSetting('automation_paused', 'false');
      } else {
        return res.status(400).json({ error: 'Action must be pause or resume' });
      }
      return res.json({ success: true, paused: !this.scheduler.isEnabled });
    });

    this.app.put('/api/settings', protect, async (req, res) => {
      const allowed = ['approval_required', 'notification_enabled', 'channel_timezone', 'max_daily_posts', 'content_buffer_days'];
      for (const key of allowed) {
        if (req.body?.[key] !== undefined) await this.db.setSetting(key, String(req.body[key]));
      }
      return res.json({ success: true, result: await this.db.getAllSettings() });
    });

    this.app.post('/api/notifications/:notificationId/read', protect, async (req, res) => {
      await this.db.markNotificationRead(req.params.notificationId);
      return res.json({ success: true });
    });
  }

  async startGenerationJob(input = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before generating content');
      error.status = 503;
      throw error;
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (this.activeJobs.size >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }

    const validation = this.validateGenerateRequestBody(input);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.status = validation.status;
      throw error;
    }

    const job = await this.db.createGenerationJob({
      ...validation.value,
      source: input.source || 'manual'
    });

    const work = this.runGenerationJob(job.id, validation.value)
      .catch(error => this.logger.error(`Generation job ${job.id} failed:`, error))
      .finally(() => this.activeJobs.delete(job.id));
    this.activeJobs.set(job.id, work);
    return job;
  }

  async runGenerationJob(jobId, input) {
    try {
      await this.db.updateGenerationJob(jobId, { status: 'running', stage: 'starting', progress: 2, error: null });
      const result = await this.generateContent(input.topic, input.style, input.length, { jobId });
      await this.db.updateGenerationJob(jobId, {
        status: 'completed',
        stage: result.reviewStatus === 'approved' ? 'scheduled' : result.reviewStatus,
        progress: 100,
        productionId: result.contentId,
        title: result.title,
        details: { reviewStatus: result.reviewStatus, qualityScore: result.qualityScore },
        completedAt: new Date().toISOString()
      });
      await this.db.setSetting('last_content_generation', new Date().toISOString());
      return result;
    } catch (error) {
      const cancelled = error.code === 'JOB_CANCELLED';
      await this.db.updateGenerationJob(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: cancelled ? 'cancelled' : 'failed',
        error: error.message,
        completedAt: new Date().toISOString()
      });
      await this.operator.notify({
        type: cancelled ? 'generation_cancelled' : 'generation_failure',
        level: cancelled ? 'warning' : 'error',
        title: cancelled ? 'Generation cancelled' : 'Generation failed',
        message: error.message,
        data: { jobId }
      });
      throw error;
    }
  }

  async updateJobStage(jobId, stage, progress, details = {}) {
    if (!jobId) return;
    const job = await this.db.getGenerationJob(jobId);
    if (job?.cancelRequested) {
      const error = new Error(job.details?.cancelReason || 'Generation cancelled by operator');
      error.code = 'JOB_CANCELLED';
      throw error;
    }
    await this.db.updateGenerationJob(jobId, { stage, progress, details });
  }

  async generateContent(topic = null, style = null, length = 'medium', options = {}) {
    this.logger.info('Starting content generation pipeline...');
    const { jobId = null } = options;
    const profile = await this.db.getChannelProfile() || {};
    const lengthLabels = { short: '2-4 minutes', medium: '8-12 minutes', long: '15-20 minutes' };

    // Step 1: Strategy
    await this.updateJobStage(jobId, 'strategy', 10);
    const strategy = await this.agents.strategy.generateContentStrategy(topic);
    const contentStyles = new Set(['tutorial', 'explainer', 'list', 'review', 'story']);
    const requestedStyle = style || profile.default_style || null;
    if (requestedStyle && contentStyles.has(requestedStyle.toLowerCase())) {
      strategy.contentType = requestedStyle.charAt(0).toUpperCase() + requestedStyle.slice(1).toLowerCase();
    }
    strategy.requestedStyle = requestedStyle;
    strategy.requestedLengthKey = length;
    strategy.requestedLength = lengthLabels[length] || lengthLabels.medium;
    strategy.targetAudience = profile.target_audience || strategy.targetAudience;
    strategy.brandVoice = profile.brand_voice || null;
    strategy.channelGoal = profile.goal || null;
    strategy.callToAction = profile.call_to_action || null;
    this.logger.info(`Strategy generated: ${strategy.topic}`);

    // Step 2: Script Writing
    await this.updateJobStage(jobId, 'script', 25, { topic: strategy.topic });
    const script = await this.agents.scriptWriter.generateScript(strategy);
    this.logger.info(`Script generated: ${script.title}`);

    // Step 3: Thumbnail Design
    await this.updateJobStage(jobId, 'thumbnail', 40, { title: script.title });
    const thumbnail = await this.agents.thumbnailDesigner.generateThumbnail(script);
    this.logger.info('Thumbnail generated');

    // Step 4: SEO Optimization
    await this.updateJobStage(jobId, 'seo', 52);
    const seoData = await this.agents.seoOptimizer.optimize(script, strategy);
    this.logger.info('SEO optimization complete');

    // Step 5: Production Management
    await this.updateJobStage(jobId, 'production', 62);
    const productionData = await this.agents.production.processContent({
      strategy,
      script,
      thumbnail,
      seo: seoData
    });
    this.logger.info('Production processing complete');

    // Step 6: Save to database
    const contentId = await this.db.saveProductionData(productionData);
    await this.db.saveProductionSnapshot(productionData);
    this.logger.info(`Content saved with ID: ${contentId}`);

    // Step 7: Quality and approval gate
    await this.updateJobStage(jobId, 'quality_review', 90, { contentId });
    const quality = await this.operator.runQualityChecks(productionData, profile);
    const approvalRequired = await this.db.getSetting('approval_required') !== 'false';
    const reviewStatus = quality.passed
      ? (approvalRequired ? 'needs_review' : 'approved')
      : 'needs_attention';
    await this.db.saveContentReview(contentId, {
      status: reviewStatus,
      qualityChecks: quality.checks,
      editorData: {},
      reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
      reviewedAt: approvalRequired ? null : new Date().toISOString()
    });

    let scheduleEntry = null;
    if (reviewStatus === 'approved') {
      scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
      await this.db.updateProductionStatus(contentId, scheduleEntry ? 'scheduled' : productionData.status);
    } else {
      await this.db.updateProductionStatus(contentId, reviewStatus);
      await this.operator.notify({
        type: 'review_required',
        level: quality.passed ? 'info' : 'warning',
        title: quality.passed ? 'Content ready for review' : 'Content needs attention',
        message: `${script.title} ${quality.passed ? 'is ready for approval' : 'failed one or more quality checks'}`,
        data: { contentId, qualityScore: quality.score }
      });
    }

    return {
      contentId,
      title: script.title,
      status: productionData.status,
      reviewStatus,
      qualityScore: quality.score,
      scheduledFor: scheduleEntry ? scheduleEntry.publishTime : null
    };
  }

  validateEditorData(input = {}, existing = {}) {
    const output = { ...existing };
    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (!title || title.length > 100) throw new Error('Title must be between 1 and 100 characters');
      output.title = title;
    }
    if (input.description !== undefined) {
      const description = String(input.description).trim();
      if (description.length > 5000) throw new Error('Description must be 5,000 characters or less');
      output.description = description;
    }
    if (input.tags !== undefined) {
      const tags = Array.isArray(input.tags)
        ? input.tags
        : String(input.tags).split(',');
      output.tags = tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 30);
    }
    if (input.publishTime !== undefined) {
      const date = new Date(input.publishTime);
      if (Number.isNaN(date.getTime())) throw new Error('Publish time must be a valid date');
      output.publishTime = date.toISOString();
    }
    if (input.privacyStatus !== undefined) {
      if (!['private', 'unlisted', 'public'].includes(input.privacyStatus)) throw new Error('Invalid privacy status');
      output.privacyStatus = input.privacyStatus;
    }
    if (input.factChecked !== undefined) output.factChecked = input.factChecked === true;
    if (input.rightsConfirmed !== undefined) output.rightsConfirmed = input.rightsConfirmed === true;
    return output;
  }

  validateProfile(input) {
    const textFields = ['channelName', 'goal', 'targetAudience', 'brandVoice', 'defaultStyle', 'callToAction', 'visualStyle', 'timezone'];
    const result = {};
    for (const field of textFields) {
      if (input[field] !== undefined) {
        const value = String(input[field]).trim();
        if (value.length > 500) throw new Error(`${field} is too long`);
        result[field] = value;
      }
    }
    if (input.bannedTopics !== undefined) {
      const topics = Array.isArray(input.bannedTopics) ? input.bannedTopics : String(input.bannedTopics).split(',');
      result.bannedTopics = topics.map(topic => String(topic).trim()).filter(Boolean).slice(0, 50);
    }
    return result;
  }

  decorateContentBundle(bundle) {
    return {
      ...bundle,
      assetUrls: {
        video: bundle.assets?.finalVideo?.path && !bundle.assets?.finalVideo?.simulated ? `/api/content/${bundle.id}/asset/video` : null,
        thumbnail: bundle.assets?.thumbnail?.path ? `/api/content/${bundle.id}/asset/thumbnail` : null,
        captions: bundle.assets?.captions?.path ? `/api/content/${bundle.id}/asset/captions` : null,
        script: bundle.assets?.script?.originalPath ? `/api/content/${bundle.id}/asset/script` : null
      }
    };
  }

  async approveContent(productionId, input) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) {
      const error = new Error('Content not found');
      error.status = 404;
      throw error;
    }
    if (bundle.schedule?.status === 'published') {
      const error = new Error('Content is already published');
      error.status = 409;
      throw error;
    }

    const editorData = this.validateEditorData(input, bundle.editorData);
    if (!editorData.factChecked || !editorData.rightsConfirmed) {
      const error = new Error('Confirm the factual review and media rights checks before approval');
      error.status = 409;
      throw error;
    }
    const productionData = {
      id: bundle.id,
      status: bundle.status,
      strategy: bundle.strategy,
      script: { ...bundle.script, title: editorData.title || bundle.script.title },
      thumbnail: bundle.thumbnail,
      seo: {
        ...bundle.seo,
        title: editorData.title || bundle.seo.title,
        description: editorData.description || bundle.seo.description,
        tags: editorData.tags || bundle.seo.tags
      },
      assets: bundle.assets,
      timeline: bundle.timeline,
      scheduledPublishTime: editorData.publishTime || input.publishTime || bundle.scheduled_publish_time,
      priority: bundle.priority,
      estimatedDuration: bundle.estimated_duration,
      privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private'
    };
    const profile = await this.db.getChannelProfile() || {};
    const quality = await this.operator.runQualityChecks(productionData, profile);
    if (!quality.passed) {
      await this.db.saveContentReview(bundle.id, {
        status: 'needs_attention', editorData, qualityChecks: quality.checks,
        reviewNotes: `Blocking checks failed: ${quality.blockingFailures.join(', ')}`
      });
      const error = new Error('Content still has blocking quality failures');
      error.status = 409;
      error.quality = quality;
      throw error;
    }

    let scheduleEntry = bundle.schedule;
    if (!scheduleEntry) {
      scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
    } else if (scheduleEntry.status !== 'published') {
      scheduleEntry.title = productionData.script.title;
      scheduleEntry.publishTime = productionData.scheduledPublishTime;
      scheduleEntry.status = 'scheduled';
      scheduleEntry.metadata = {
        ...scheduleEntry.metadata,
        seo: productionData.seo,
        thumbnail: productionData.assets.thumbnail,
        video: productionData.assets.finalVideo,
        captions: productionData.assets.captions,
        privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private'
      };
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.agents.publishing.loadPublishQueue();
    }
    if (!scheduleEntry) {
      const error = new Error('A real MP4 is required before content can be approved for scheduling');
      error.status = 409;
      throw error;
    }

    await this.db.saveContentReview(bundle.id, {
      status: 'approved', editorData, qualityChecks: quality.checks,
      reviewNotes: input.reviewNotes || 'Approved by operator', reviewedAt: new Date().toISOString()
    });
    await this.db.updateProductionStatus(bundle.id, 'scheduled');
    await this.operator.notify({
      type: 'content_approved', level: 'success', title: 'Content approved',
      message: `${productionData.script.title} is scheduled for ${scheduleEntry.publishTime}`,
      data: { productionId, publishTime: scheduleEntry.publishTime }
    });
    return { productionId, reviewStatus: 'approved', qualityScore: quality.score, schedule: scheduleEntry };
  }

  async start() {
    const initialized = await this.initialize();
    
    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }
    
    const PORT = process.env.PORT || 3456;
    this.app.listen(PORT, () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on port ${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.gray('─'.repeat(50)));
      if (this.setupRequired) {
        console.log(chalk.yellow('\n⚙️  Setup is required. The dashboard is available; run npm run walkthrough to enable generation.'));
      } else {
        console.log(chalk.yellow('\n🤖 Automation is active. Approved content will be published on schedule.'));
      }
    });
  }
}

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  agent.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent };
