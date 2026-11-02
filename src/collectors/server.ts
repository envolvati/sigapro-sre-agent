import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'

export interface ContainerMemoryStat {
  name: string
  memoryMB: number
  memoryGB: number
  status: string
}

export interface HostMetrics {
  cpuCores: number
  loadAvg: { '1m': number; '5m': number; '15m': number }
  memory: {
    totalGB: number
    usedGB: number
    freeGB: number
    usedPercent: number
  }
  disk: {
    totalGB: number
    usedGB: number
    freeGB: number
    usedPercent: number
  }
  containers: ContainerMemoryStat[]
}

export class ServerCollector {
  private readonly socketPath = '/var/run/docker.sock'

  private dockerGet<T>(path: string): Promise<T | null> {
    return new Promise(resolve => {
      if (!fs.existsSync(this.socketPath)) {
        return resolve(null)
      }

      const req = http.get({ socketPath: this.socketPath, path }, res => {
        let data = ''
        res.on('data', chunk => {
          data += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T)
          } catch {
            resolve(null)
          }
        })
      })

      req.on('error', () => resolve(null))
      req.setTimeout(4000, () => {
        req.destroy()
        resolve(null)
      })
    })
  }

  async getContainersMemory(): Promise<ContainerMemoryStat[]> {
    try {
      interface DockerContainer {
        Id: string
        Names?: string[]
        State?: string
        Status?: string
      }

      const containers = await this.dockerGet<DockerContainer[]>('/v1.41/containers/json')
      if (!containers || !Array.isArray(containers)) {
        return []
      }

      const statsPromises = containers.map(async c => {
        const rawName = c.Names?.[0] ?? c.Id.slice(0, 12)
        const cleanName = rawName.replace(/^\//, '')

        interface DockerStats {
          memory_stats?: {
            usage?: number
          }
        }

        const stats = await this.dockerGet<DockerStats>(
          `/v1.41/containers/${c.Id}/stats?stream=false`,
        )
        const usageBytes = stats?.memory_stats?.usage ?? 0
        const memoryMB = Math.round((usageBytes / 1024 / 1024) * 100) / 100
        const memoryGB = Math.round((usageBytes / 1024 / 1024 / 1024) * 100) / 100

        return {
          name: cleanName,
          memoryMB,
          memoryGB,
          status: c.State ?? 'running',
        }
      })

      const results = await Promise.all(statsPromises)
      // Ordena por maior consumo de memória
      return results.sort((a, b) => b.memoryMB - a.memoryMB)
    } catch {
      return []
    }
  }

  async getHostMetrics(): Promise<HostMetrics> {
    // 1. Memória Host
    const totalBytes = os.totalmem()
    const freeBytes = os.freemem()
    const usedBytes = totalBytes - freeBytes

    const totalGB = Math.round((totalBytes / 1024 / 1024 / 1024) * 10) / 10
    const usedGB = Math.round((usedBytes / 1024 / 1024 / 1024) * 10) / 10
    const freeGB = Math.round((freeBytes / 1024 / 1024 / 1024) * 10) / 10
    const usedPercent = Math.round((usedBytes / totalBytes) * 100)

    // 2. CPU / Load
    const cpus = os.cpus()
    const [load1, load5, load15] = os.loadavg()

    // 3. Disco
    let disk = { totalGB: 0, usedGB: 0, freeGB: 0, usedPercent: 0 }
    try {
      const stat = fs.statfsSync('/')
      const dTotalGB = Math.round(((stat.blocks * stat.bsize) / 1024 / 1024 / 1024) * 10) / 10
      const dFreeGB = Math.round(((stat.bfree * stat.bsize) / 1024 / 1024 / 1024) * 10) / 10
      const dUsedGB = Math.round((dTotalGB - dFreeGB) * 10) / 10
      const dUsedPercent = Math.round((dUsedGB / dTotalGB) * 100)
      disk = {
        totalGB: dTotalGB,
        usedGB: dUsedGB,
        freeGB: dFreeGB,
        usedPercent: dUsedPercent,
      }
    } catch {
      // statfs indisponível
    }

    // 4. Containers
    const containers = await this.getContainersMemory()

    return {
      cpuCores: cpus.length,
      loadAvg: {
        '1m': Math.round(load1 * 100) / 100,
        '5m': Math.round(load5 * 100) / 100,
        '15m': Math.round(load15 * 100) / 100,
      },
      memory: {
        totalGB,
        usedGB,
        freeGB,
        usedPercent,
      },
      disk,
      containers,
    }
  }
}
