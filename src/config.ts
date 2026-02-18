import fs from "node:fs";
import toml from "toml";

export interface Config {
  app: {
    auth_token: string;
    /**
     * in seconds
     */
    cleanup_interval: number;
  };
  cache: {
    url: string;
  };
  master: {
    api_base: string;
    username: string;
    password: string;
  };
  server: {
    node_name: string;
    port_range: [number, number];
    remote_addr: string;
  }[];
}

const content = fs.readFileSync("config.toml", "utf-8");

export const config = toml.parse(content) as Config;
export default config;
