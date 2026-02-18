import { Mutex } from "async-mutex";
import { customAlphabet } from "nanoid";
import z from "zod";
import type { CreateConfigParam } from "@/api";
import * as api from "@/api";
import { Cache } from "@/cache";
import config from "@/config";
import { normalize_service, sleep, to_camel } from "./utils";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 21);

const cache = new Cache(config.cache.url);

// port:{server_id}:{port} -> traffic_id
// traffic:{traffic_id}:conf -> { client_id, server_id, config }
// traffic:{traffic_id}:addr -> { remote_ports: number[], remote_addr: string[] }

interface ProxyConfigDetail {
  name: string;
  type: string;
  local_port: number;
  local_ip: string;
  subdomain?: string;
  remote_port?: number;
}

namespace Cached {
  export interface TrafficConfig {
    client_id: string;
    server_id: string;
    config: {
      proxies: ProxyConfigDetail[];
    };
  }
  export interface TrafficAddr {
    remote_ports: number[];
    remote_addr: Record<string, string>; // name:port/service_type -> remote_addr
  }
}

declare global {
  interface String {
    parseJSON<T>(): T | null;
  }
}

String.prototype.parseJSON = function <T>(this: string) {
  try {
    return JSON.parse(this) as T;
  } catch (error) {
    console.error("JSON parse error:", error);
    return null;
  }
};

const mutex_port = new Mutex();
const mutex_cache_w = new Mutex();

function delta_now(seconds: number) {
  return seconds - Math.floor(Date.now() / 1000);
}

function gen_http_config(name: string, subdomain: string, local_port: number, local_ip = "127.0.0.1") {
  return {
    name,
    type: "http",
    local_port,
    local_ip,
    subdomain,
  };
}

function gen_tcp_config(name: string, remote_port: number, local_port: number, local_ip = "127.0.0.1") {
  return {
    name,
    type: "tcp",
    remote_port,
    local_port,
    local_ip,
  };
}

function gen_udp_config(name: string, remote_port: number, local_port: number, local_ip = "127.0.0.1") {
  return {
    name,
    type: "udp",
    remote_port,
    local_port,
    local_ip,
  };
}

async function get_occupied_ports(server_id: string) {
  const keys = await cache.at("port").at(server_id).at("*").keys();
  return keys.map((key) => {
    const parts = key.split(":");
    return parseInt(parts[parts.length - 1]!, 10);
  });
}

async function get_available_ports(server_id: string, port_range: [number, number], count = 1) {
  const occupied_ports = await get_occupied_ports(server_id);
  const rand_port = Math.floor(Math.random() * (port_range[1] - port_range[0] + 1)) + port_range[0];
  const result: number[] = [];
  if (!occupied_ports.includes(rand_port)) {
    result.push(rand_port);
  }

  if (result.length >= count) return result;

  // up find
  let try_port = rand_port + 1;
  while (try_port <= port_range[1]) {
    if (!occupied_ports.includes(try_port)) {
      result.push(try_port);
      if (result.length >= count) return result;
    }
    try_port++;
  }
  // down find
  try_port = rand_port - 1;
  while (try_port >= port_range[0]) {
    if (!occupied_ports.includes(try_port)) {
      result.push(try_port);
      if (result.length >= count) return result;
    }
    try_port--;
  }
  throw new Error("No available port found in the specified range");
}

async function gen_config_proxies(
  ctx: { node_name: string; traffic_id: string; server_id: string; port_range: [number, number] },
  name_prefix: string,
  ports: NormalizedService["ports"]
): Promise<ProxyConfigDetail[]> {
  const result: ProxyConfigDetail[] = [];
  const need_ports = ports.filter((p) => p.service_type !== "http");
  let remote_ports: number[] = [];
  if (need_ports.length) {
    remote_ports = await get_available_ports(ctx.server_id, ctx.port_range, need_ports.length);
  }
  for (const port_info of ports) {
    const name = `${name_prefix}:${port_info.name}:${port_info.node_port}/${port_info.service_type}`;
    if (port_info.service_type === "http") {
      const prefix = ctx.node_name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
      const subdomain = `${prefix}-${nanoid()}`;
      result.push(gen_http_config(name, subdomain, port_info.node_port));
    } else if (port_info.service_type === "tcp") {
      const remote_port = remote_ports.shift()!;
      result.push(gen_tcp_config(name, remote_port, port_info.node_port));
    } else if (port_info.service_type === "udp") {
      const remote_port = remote_ports.shift()!;
      result.push(gen_udp_config(name, remote_port, port_info.node_port));
    }
  }
  return result;
}

export interface Service {
  traffic: string;
  /**
   * seconds
   */
  created_at: number;
  /**
   * seconds
   */
  lifetime: number;
  ports: {
    name: string;
    node_port: number;
    service_type?: "http" | "tcp" | "udp";
    protocol: "TCP" | "UDP" | "STCP";
    app_protocol: "raw" | "http";
  }[];
}

export interface NormalizedService extends Omit<Service, "ports"> {
  ports: (Service["ports"][number] & { service_type: "http" | "tcp" | "udp" })[];
}

export const schemaService = z.object({
  traffic: z.string(),
  created_at: z.number(),
  lifetime: z.number(),
  ports: z.array(
    z.object({
      name: z.string(),
      node_port: z.number(),
      service_type: z.enum(["http", "tcp", "udp"]).optional(),
      protocol: z.enum(["TCP", "UDP", "STCP"]),
      app_protocol: z.enum(["raw", "http"]),
    })
  ),
});

async function update_traffic_unsafe(node_name: string, service: Service) {
  const svc = normalize_service(service);

  const SERVER_ID_PREFIX = `${config.master.username}.s`;
  const CLIENT_ID = `${config.master.username}.c.${node_name}`;
  const NAME_PREFIX = `ret2shell:${svc.traffic}`;
  const server_config = config.server.find((s) => s.node_name === node_name);
  if (!server_config) throw new Error(`No config found for server: node_name: ${node_name}`);

  const cache_key_conf = cache.at("traffic").at(svc.traffic).at("conf");
  const cache_key_addr = cache.at("traffic").at(svc.traffic).at("addr");
  const cached_conf = (await cache_key_conf.get())?.parseJSON<Cached.TrafficConfig>() ?? null;
  const cached_addr = (await cache_key_addr.get())?.parseJSON<Cached.TrafficAddr>() ?? null;

  const SVC_EXPIRE_AT = svc.created_at + svc.lifetime;

  if (cached_conf && cached_addr) {
    // update expire time
    const delta = delta_now(SVC_EXPIRE_AT);
    await Promise.all([cache_key_conf.expire(delta), cache_key_addr.expire(delta)]);

    return cached_addr.remote_addr;
  } else {
    // create new

    const server_id = await api.list_all_servers(SERVER_ID_PREFIX);
    if (!server_id.length) throw new Error("No available frp server found");
    const picked_server_id = server_id[Math.floor(Math.random() * server_id.length)]!.id;
    const ctx = {
      node_name,
      traffic_id: svc.traffic,
      server_id: picked_server_id,
      port_range: server_config.port_range,
    };
    // create proxy config, occupy ports
    const [config, occupied_ports] = await mutex_port.runExclusive(async () => {
      const proxies = await gen_config_proxies(ctx, NAME_PREFIX, svc.ports);

      const create_params: CreateConfigParam<Cached.TrafficConfig["config"]> = {
        client_id: CLIENT_ID,
        server_id: picked_server_id,
        config: to_camel({ proxies }),
        // if already exists cached_conf, overwrite it
        overwrite: true,
      };

      // create config
      await api.create_proxy_config(create_params);

      // occupy ports
      const occupied_ports = proxies
        .filter((p) => p.type !== "http" && p.remote_port)
        .map((p) => p.remote_port!) as number[];
      const delta = delta_now(SVC_EXPIRE_AT);
      await Promise.all(
        occupied_ports.map((p) => {
          // set port:{traffic_id}:{port} -> traffic_id, with expire
          return cache.at("port").at(ctx.server_id).at(p).set(ctx.traffic_id, delta);
        })
      );
      return [create_params.config, occupied_ports];
    });

    const proxy_lists = await api.list_all_proxy_configs(`${NAME_PREFIX}:`);
    if (!proxy_lists.length) throw new Error("Failed to list proxy configs after creation");

    // set traffic:{traffic_id}:conf -> Cached.TrafficConfig, with expire
    // if already exists cached_conf, it will overwrite it
    await cache_key_conf.set(
      JSON.stringify({
        client_id: proxy_lists[0]!.client_id,
        server_id: proxy_lists[0]!.server_id,
        config: config,
      }),
      delta_now(SVC_EXPIRE_AT)
    );

    // get remote address
    const details = await Promise.all(
      proxy_lists.map((proxy) =>
        api
          .get_proxy_config({
            client_id: proxy.client_id,
            server_id: proxy.server_id,
            name: proxy.name,
          })
          .then((res) => res.body)
      )
    );

    const remote_addr = new Map<string, string>(); // name:port/service_type -> remote_addr

    for (const detail of details) {
      const port_key = detail.working_status.name.split(":").slice(-2).join(":");
      if (detail.working_status.type === "http") {
        remote_addr.set(port_key, detail.working_status.remote_addr);
      } else {
        remote_addr.set(port_key, `${server_config.remote_addr}:${detail.working_status.remote_addr.split(":").pop()}`);
      }
    }

    // set traffic:{traffic_id}:addr -> Cached.TrafficAddr, with expire
    // if already exists cached_addr, it will overwrite it
    await cache_key_addr.set(
      JSON.stringify({
        remote_ports: occupied_ports,
        remote_addr,
      }),
      delta_now(SVC_EXPIRE_AT)
    );

    return Object.fromEntries(remote_addr.entries());
  }
}

export function update_traffic(node_name: string, service: Service) {
  return mutex_cache_w.runExclusive(() => update_traffic_unsafe(node_name, service));
}

export async function delete_traffic(traffic_id: string) {
  const cache_key_conf = cache.at("traffic").at(traffic_id).at("conf");
  const cache_key_addr = cache.at("traffic").at(traffic_id).at("addr");
  const cached_conf = (await cache_key_conf.get())?.parseJSON<Cached.TrafficConfig>() ?? null;
  const cached_addr = (await cache_key_addr.get())?.parseJSON<Cached.TrafficAddr>() ?? null;

  const info = {
    traffic_id,
    remote_addr: cached_addr?.remote_addr,
  };

  if (cached_conf && cached_addr) {
    const server_id = cached_conf.server_id;
    const remote_ports = cached_addr.remote_ports;
    await Promise.all([
      // delete traffic
      cache_key_conf.del(),
      cache_key_addr.del(),
      // delete all ports
      ...remote_ports.map((port) => cache.at("port").at(server_id).at(port).del()),
    ]);
  } else {
    await Promise.all([
      // delete traffic
      cache_key_conf.del(),
      cache_key_addr.del(),
      // we cannot infer cache key of ports, the cleanup ticker will help us delete traffic
    ]);
  }

  return info;
}

async function cleanup_dead_ports() {
  const all_port_keys = await cache.at("port").at("*").at("*").keys();
  for (const port_key of all_port_keys) {
    await mutex_cache_w.runExclusive(async () => {
      const [_, server_id, port_str] = port_key.split(":") as [string, string, string];
      const cache_key_port = cache.at("port").at(server_id).at(port_str);
      const traffic_id = await cache_key_port.get();
      if (traffic_id) {
        const cache_key_conf = cache.at("traffic").at(traffic_id).at("conf");
        const cache_key_addr = cache.at("traffic").at(traffic_id).at("addr");
        // if exists cache_conf, it's valid
        // only check if cache_conf exists
        const should_delete = !(await cache_key_conf.exists());
        if (should_delete) {
          console.log(`Cleaning up dead port: server_id=${server_id}, port=${port_str}, traffic_id=${traffic_id}`);
          await Promise.all([
            // delete traffic
            cache_key_conf.del(),
            cache_key_addr.del(),
            // delete port
            cache_key_port.del(),
          ]);
        }
      } else {
        // invalid cache entry, just delete it
        console.log(`Cleaning up invalid port entry: server_id=${server_id}, port=${port_str}`);
        await cache_key_port.del().catch(void 0);
      }
    });
    await sleep(10);
  }
}

export async function start_cleanup_dead_ports() {
  let last_cleanup_time = 0;
  const INTERVAL = config.app.cleanup_interval * 1000;
  const ticker = async () => {
    last_cleanup_time = Date.now();
    try {
      await cleanup_dead_ports();
    } catch (e) {
      console.error("Error during cleanup:", e);
    }
    // infer next tick time
    const next_tick = Math.max(0, INTERVAL - (Date.now() - last_cleanup_time));
    setTimeout(ticker, next_tick);
  };
  setTimeout(ticker, INTERVAL);
}
