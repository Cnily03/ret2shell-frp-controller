import type { NormalizedService, Service } from "./traffic";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// biome-ignore lint/suspicious/noExplicitAny: generic
export function to_camel(obj: any): any {
  if (Array.isArray(obj)) return obj.map(to_camel);
  else if (obj !== null && typeof obj === "object") {
    // biome-ignore lint/suspicious/noExplicitAny: generic
    const newObj: any = {};
    for (const key in obj) {
      const camelKey = key.replace(/_([a-z])/g, (g) => g[1]!.toUpperCase());
      newObj[camelKey] = to_camel(obj[key]);
    }
    return newObj;
  } else {
    return obj;
  }
}

export function normalize_service(service: Service): NormalizedService {
  for (const p of service.ports) {
    if (p.app_protocol === "http") p.service_type = "http";
    else if (p.protocol === "UDP") p.service_type = "udp";
    else p.service_type = "tcp";
  }
  return service as unknown as NormalizedService;
}
