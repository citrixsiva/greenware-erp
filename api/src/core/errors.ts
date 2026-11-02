export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) { super(message); }
}
export const badRequest = (c: string, m: string, d?: unknown) => new AppError(400, c, m, d);
export const unauthorized = (m = 'Authentication required') => new AppError(401, 'unauthenticated', m);
export const forbidden = (m = 'You do not have permission to do that') => new AppError(403, 'forbidden', m);
export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (c: string, m: string, d?: unknown) => new AppError(409, c, m, d);
/** Gate violations (§18 §19 §24 §25) get their own code so the UI can explain them. */
export const gateBlocked = (m: string, d?: unknown) => new AppError(422, 'gate_blocked', m, d);
