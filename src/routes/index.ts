import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import z from "zod";
import { auth } from "@/mw/auth";
import { delete_traffic, schemaService, update_traffic } from "@/traffic";

const app = new Hono();

const app_v1 = new Hono();
app.all("/ping", (c) => c.text("pong"));

app_v1.use(auth);

const schemaUpdate = z.object({
  node_name: z.string(),
  service: schemaService,
});

// create or update traffic
app_v1.post("/traffic", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) throw new HTTPException(400, { message: "invalid request body" });
  const update = schemaUpdate.parse(body);
  const remote_addr = await update_traffic(update.node_name, update.service);
  return c.json(remote_addr);
});

app_v1.delete("/traffic", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) throw new HTTPException(400, { message: "invalid request body" });
  const { traffic_id } = z.object({ traffic_id: z.string() }).parse(body);
  const deleted = await delete_traffic(traffic_id);
  return c.json(deleted);
});

app.route("/v1", app_v1);

app.onError((e, c) => {
  if (e instanceof HTTPException) {
    return c.text(e.message, e.status);
  } else if (e instanceof z.ZodError) {
    return c.text("invalid request body", 400);
  } else {
    console.error(e);
    return c.text("internal server error", 500);
  }
});
