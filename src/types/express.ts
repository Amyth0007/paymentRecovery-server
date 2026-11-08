import type { AuthContext } from "../common/auth/auth-context.js";

export {};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
