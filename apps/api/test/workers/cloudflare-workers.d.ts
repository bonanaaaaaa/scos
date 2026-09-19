// The Worker's bindings as `cloudflare:workers` exposes them inside workerd
// (Workers integration tests only; the app itself receives `env` as a
// handler argument and needs no Workers type package).
declare module "cloudflare:workers" {
  export const env: {
    readonly HYPERDRIVE: { readonly connectionString: string };
    readonly [name: string]: unknown;
  };
}
