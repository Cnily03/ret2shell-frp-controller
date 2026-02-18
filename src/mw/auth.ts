import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import config from "@/config";

export const auth = createMiddleware(async (c, next) => {
  const AUTH_TOKEN = config.app.auth_token;
  const auth_header = c.req.header("Authorization") ?? "";
  if (auth_header === `Bearer ${AUTH_TOKEN}`) {
    await next();
  } else {
    throw new HTTPException(401, { message: "unauthorized" });
  }
});
