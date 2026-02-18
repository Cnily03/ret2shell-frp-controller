import { Base64 } from "js-base64";
import ky from "ky";
import config from "@/config";
import { Cache } from "./cache";
import { to_camel } from "./utils";

const cache = new Cache(config.cache.url);

function storeToken(token: string, expireSec = 86400 - 1800) {
  return cache.at("token").at(config.master.username).set(token, expireSec);
}

const api = ky.create({
  prefixUrl: config.master.api_base,
  timeout: 5000,
  retry: 3,
  hooks: {
    beforeRequest: [
      async (request, _) => {
        let token = await cache.at("token").at(config.master.username).get();
        if (!token) {
          const data = await login(config.master.username, config.master.password);
          if (data.code === 200 && data.body.token) {
            token = data.body.token;
            await storeToken(token);
          }
        }
        if (token) {
          request.headers.set("Authorization", `Bearer ${token}`);
        }
      },
    ],
    afterResponse: [
      async (_, __, response) => {
        const json = await response.json<Wrap<null>>();
        if (json.code === 500 && json.msg === "token invalid") {
          const data = await login(config.master.username, config.master.password);
          if (data.code === 200 && data.body.token) {
            await storeToken(data.body.token);
          }
        }
        let newToken = response.headers.get("X-Set-Authorization");
        if (!newToken) newToken = response.headers.get("Set-Cookie")?.match(/frp-panel-cookie=([^;]+)/)?.[1] || null;
        if (newToken) {
          await storeToken(newToken);
        }
      },
    ],
  },
});

type Wrap<T> = {
  code: number;
  msg: string;
  body: T & { status: { code: number; message: string } };
};

export interface LoginResponse {
  token: string;
}

export interface Server {
  id: string;
  secret: string;
  ip: string;
  config: string;
  comment: string;
}

export interface Client {
  id: string;
  secret: string;
  config: string;
  comment: string;
  server_id: string;
  stopped: boolean;
  /**
   * contains `@{user_id}` for unique identification
   */
  client_ids: string[];
  ephemeral: boolean;
  last_seen_at: number;
}

export function login(username: string, password: string) {
  return ky
    .post("v1/auth/login", {
      prefixUrl: config.master.api_base,
      json: { username, password },
    })
    .json<Wrap<LoginResponse>>();
}

interface ListParam {
  page?: number;
  page_size?: number;
  keyword?: string;
}

export function list_servers(param: ListParam = {}) {
  const json = Object.assign({ page: 1, page_size: 8, keyword: "" }, param);
  return api
    .post("v1/server/list", {
      json: { page: json.page, pageSize: json.page_size, keyword: json.keyword },
    })
    .json<Wrap<{ total: number; servers: Server[] }>>();
}

export async function list_all_servers(keyword = "") {
  let page = 1;
  const page_size = 100;
  let total = 0;
  const result: Server[] = [];
  do {
    const res = await list_servers({ page, page_size, keyword });
    if (res.code === 200) {
      total = res.body.total;
      result.push(...res.body.servers);
      page++;
    } else {
      break;
    }
  } while (result.length < total);
  return result;
}

export function list_clients(param: ListParam = {}) {
  const json = Object.assign({ page: 1, page_size: 8, keyword: "" }, param);
  return api
    .post("v1/client/list", {
      json: { page: json.page, pageSize: json.page_size, keyword: json.keyword },
    })
    .json<Wrap<{ total: number; clients: Client[] }>>();
}

export async function list_all_clients(keyword = "") {
  let page = 1;
  const page_size = 100;
  let total = 0;
  const result: Client[] = [];
  do {
    const res = await list_clients({ page, page_size, keyword });
    if (res.code === 200) {
      total = res.body.total;
      result.push(...res.body.clients);
      page++;
    } else {
      break;
    }
  } while (result.length < total);
  return result;
}

export interface CreateConfigParam<T> {
  client_id: string;
  server_id: string;
  /**
   * camel case
   */
  config: T;
  overwrite?: boolean;
}

export function create_proxy_config<T>(param: CreateConfigParam<T>) {
  const configBase64 = Base64.encode(JSON.stringify(param.config));
  return api
    .post("v1/proxy/create_config", {
      json: {
        clientId: param.client_id,
        serverId: param.server_id,
        config: configBase64,
        overwrite: param.overwrite,
      },
    })
    .json<Wrap<{}>>();
}

interface ProxyConfigUniqueKey {
  /**
   * should contains `@{user_id}`
   */
  client_id: string;
  server_id: string;
  name: string;
}

export function delete_proxy_config(params: ProxyConfigUniqueKey) {
  return api
    .post("v1/proxy/delete_config", {
      json: to_camel(params),
    })
    .json<Wrap<{}>>();
}

interface ProxyConfig {
  id: number;
  name: string;
  type: string;
  /**
   * should contains `@{user_id}` for unique identification
   */
  client_id: string;
  server_id: string;
  config: string;
  origin_client_id: string;
  stopped: boolean;
}

export function list_proxy_configs(param: ListParam = {}) {
  const json = Object.assign({ page: 1, page_size: 8, keyword: "" }, param);
  return api
    .post("v1/proxy/list_configs", { json: to_camel(json) })
    .json<Wrap<{ total: number; proxy_configs: ProxyConfig[] }>>();
}

export async function list_all_proxy_configs(keyword = "") {
  let page = 1;
  const page_size = 100;
  let total = 0;
  const result: ProxyConfig[] = [];
  do {
    const res = await list_proxy_configs({ page, page_size, keyword });
    if (res.code === 200) {
      total = res.body.total;
      result.push(...res.body.proxy_configs);
      page++;
    } else {
      break;
    }
  } while (result.length < total);
  return result;
}

export interface WorkingStatus {
  name: string;
  type: string;
  status: string;
  err: string;
  remote_addr: string;
}

export function get_proxy_config(param: ProxyConfigUniqueKey) {
  return api
    .post("v1/proxy/get_config", { json: to_camel(param) })
    .json<Wrap<{ proxy_config: ProxyConfig; working_status: WorkingStatus }>>();
}
