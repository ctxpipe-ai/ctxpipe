declare module "dockerode" {
  export default class Dockerode {
    ping(): Promise<unknown>
  }
}
