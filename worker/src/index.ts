import { handleRequest, type WorkerEnv } from "./transcribe";

/**
 * Cloudflare Workers entry point. The whole surface is in `transcribe.ts` so
 * the routing, CORS and normalisation can be tested without the runtime.
 */
export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> | Response {
    return handleRequest(request, env);
  },
};
