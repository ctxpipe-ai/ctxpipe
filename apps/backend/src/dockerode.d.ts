declare module "dockerode" {
  export default class Dockerode {
    constructor(options?: { timeout?: number; connectionTimeout?: number })
    ping(): Promise<unknown>
  }
}
