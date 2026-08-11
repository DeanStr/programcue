export type FormJsImportRequest = {
  fingerprint: string;
  run(): Promise<void>;
};

export type FormJsImportQueue = {
  enqueue(request: FormJsImportRequest): void;
  dispose(): void;
};

/**
 * form-js mutates one editor instance while importing. Keep those mutations
 * serial and retain only the newest schema requested while an import is in
 * flight so a slower, older import cannot become the final visual state.
 */
export function createFormJsImportQueue(): FormJsImportQueue {
  let disposed = false;
  let running = false;
  let pending: FormJsImportRequest | null = null;

  async function drain() {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && pending) {
        const request = pending;
        pending = null;
        await request.run();
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(request) {
      if (disposed) return;
      pending = request;
      void drain();
    },
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}
