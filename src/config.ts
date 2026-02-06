import fs from "node:fs";
import toml from "toml";

export interface Config {
  cache: {
    url: string;
  };
  master: {
    api_base: string;
    username: string;
    password: string;
  };
}

const content = fs.readFileSync("config.toml", "utf-8");

export const config = toml.parse(content) as Config;
export default config;
