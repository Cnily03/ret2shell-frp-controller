import config from "@/config";
import app from "@/routes/index";

export default {
  port: config.app.port,
  fetch: app.fetch,
};
