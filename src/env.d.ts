interface CloudflareEnv {
  RERUN_STORE: KVNamespace;
}

declare global {
  namespace NodeJS {
    interface ProcessEnv extends CloudflareEnv {}
  }
}

export {};
