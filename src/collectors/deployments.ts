export interface DeploymentEvent {
  id: string
  application: string
  environment: string
  branch?: string
  commit?: string
  commitMessage?: string
  author?: string
  status: 'SUCCESS' | 'FAILED'
  duration?: string
  timestamp: string
  triage?: {
    summary: string
    rootCause: string
    culpritFiles: string[]
    harnessPrompt: string
  }
}

export class DeploymentsCollector {
  private static instance: DeploymentsCollector
  private readonly events: DeploymentEvent[] = []
  private readonly maxEvents = 20

  static getInstance(): DeploymentsCollector {
    if (!DeploymentsCollector.instance) {
      DeploymentsCollector.instance = new DeploymentsCollector()
    }
    return DeploymentsCollector.instance
  }

  recordDeployment(event: DeploymentEvent): void {
    this.events.unshift(event)
    if (this.events.length > this.maxEvents) {
      this.events.pop()
    }
  }

  getRecentDeployments(limit = 5): DeploymentEvent[] {
    return this.events.slice(0, limit)
  }
}
