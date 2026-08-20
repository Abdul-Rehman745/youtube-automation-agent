const { Logger } = require('./logger');

class AutonomousChannelOperator {
  constructor(db, options = {}) {
    this.db = db;
    this.researchAndPlan = options.researchAndPlan;
    this.startGenerationJob = options.startGenerationJob;
    this.waitForGenerationJob = options.waitForGenerationJob;
    this.notify = options.notify || (async () => null);
    this.logger = new Logger('AutonomousOperator');
    this.activeRuns = new Map();
  }

  async start(strategy) {
    if (!strategy || strategy.status !== 'active') {
      const error = new Error('Save and activate a channel strategy before starting the autonomous operator');
      error.status = 409;
      throw error;
    }
    const active = await this.db.getActiveOperatorRun();
    if (active || this.activeRuns.size) {
      const error = new Error('An autonomous operator run is already active');
      error.status = 409;
      throw error;
    }

    const run = await this.db.createOperatorRun(strategy.id);
    const work = this.execute(run.id, strategy)
      .catch(error => this.logger.error(`Operator run ${run.id} failed:`, error))
      .finally(() => this.activeRuns.delete(run.id));
    this.activeRuns.set(run.id, work);
    return run;
  }

  async execute(runId, strategy) {
    try {
      await this.update(runId, { status: 'running', stage: 'researching', progress: 5, error: null });
      const { research, plan } = await this.researchAndPlan(strategy);
      if (!plan.length) throw new Error('Research did not produce any usable content ideas');
      await this.assertNotCancelled(runId);
      await this.update(runId, { stage: 'planning', progress: 20, research, plan });

      const generatedJobs = [];
      for (let index = 0; index < plan.length; index++) {
        await this.assertNotCancelled(runId);
        const item = plan[index];
        const idea = await this.db.createContentIdea({
          topic: item.topic,
          angle: item.angle,
          style: item.format,
          status: 'generating',
          rationale: item.rationale
        });
        const progress = 20 + Math.round((index / plan.length) * 70);
        await this.update(runId, {
          stage: `producing_${index + 1}_of_${plan.length}`,
          progress,
          generatedJobs
        });

        const record = { jobId: null, ideaId: idea.id, topic: item.topic, status: 'queued' };
        generatedJobs.push(record);
        try {
          await this.update(runId, { generatedJobs });
          await this.assertNotCancelled(runId);
          const job = await this.startGenerationJob({
            topic: item.topic,
            style: item.format,
            length: item.length,
            source: 'autonomous_operator',
            strategyContext: {
              angle: item.angle,
              rationale: item.rationale,
              audience: strategy.audience,
              objective: strategy.objective,
              valueProposition: strategy.value_proposition,
              constraints: strategy.constraints
            }
          });
          record.jobId = job.id;
          record.status = 'running';
          await this.update(runId, { generatedJobs });
          const completed = await this.waitForGenerationJob(job.id);
          record.status = completed.status;
          record.productionId = completed.production_id || null;
          record.reviewStatus = completed.details?.reviewStatus || null;
          record.error = completed.error || null;
          await this.db.updateContentIdea(idea.id, {
            status: completed.status === 'completed' ? 'generated' : 'failed'
          });
        } catch (error) {
          record.status = error.code === 'OPERATOR_CANCELLED' ? 'cancelled' : 'failed';
          record.error = error.message;
          await this.db.updateContentIdea(idea.id, { status: 'failed' });
          if (error.code === 'OPERATOR_CANCELLED') throw error;
        }
        await this.update(runId, {
          progress: 20 + Math.round(((index + 1) / plan.length) * 70),
          generatedJobs
        });
      }

      const completed = generatedJobs.filter(job => job.status === 'completed');
      const needsReview = completed.filter(job => ['needs_review', 'needs_attention'].includes(job.reviewStatus));
      const failed = generatedJobs.filter(job => job.status !== 'completed');
      const allFailed = completed.length === 0 && failed.length > 0;
      const status = allFailed ? 'failed' : needsReview.length ? 'waiting_review' : failed.length ? 'completed_with_issues' : 'completed';
      const summary = {
        planned: plan.length,
        generated: completed.length,
        needsReview: needsReview.length,
        failed: failed.length
      };
      await this.update(runId, {
        status,
        stage: allFailed ? 'failed' : needsReview.length ? 'waiting_for_review' : 'complete',
        progress: 100,
        generatedJobs,
        summary,
        error: allFailed ? 'Every planned video failed during generation' : null,
        completedAt: new Date().toISOString()
      });
      await this.notify({
        type: 'autonomous_run_complete',
        level: failed.length ? 'warning' : 'success',
        title: needsReview.length ? 'Autonomous plan is ready for review' : 'Autonomous plan completed',
        message: `${completed.length} of ${plan.length} planned videos finished production.`,
        data: { runId, ...summary }
      });
    } catch (error) {
      const cancelled = error.code === 'OPERATOR_CANCELLED';
      await this.update(runId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: cancelled ? 'cancelled' : 'failed',
        error: error.message,
        completedAt: new Date().toISOString()
      });
      if (!cancelled) {
        await this.notify({
          type: 'autonomous_run_failure',
          level: 'error',
          title: 'Autonomous channel run failed',
          message: error.message,
          data: { runId }
        });
      }
      throw error;
    }
  }

  async cancel(runId) {
    const run = await this.db.getOperatorRun(runId);
    if (!run) return null;
    if (!['queued', 'running', 'cancelling'].includes(run.status)) return run;
    for (const item of run.generatedJobs) {
      const job = await this.db.getGenerationJob(item.jobId);
      if (job && ['queued', 'running'].includes(job.status)) {
        await this.db.updateGenerationJob(job.id, {
          cancelRequested: true,
          details: { cancelReason: 'Autonomous operator stopped by the channel owner' }
        });
      }
    }
    return this.update(runId, { status: 'cancelling', cancelRequested: true });
  }

  async assertNotCancelled(runId) {
    const run = await this.db.getOperatorRun(runId);
    if (run?.cancelRequested) {
      const error = new Error('Autonomous operator stopped by the channel owner');
      error.code = 'OPERATOR_CANCELLED';
      throw error;
    }
  }

  update(runId, changes) {
    return this.db.updateOperatorRun(runId, changes);
  }
}

module.exports = { AutonomousChannelOperator };
