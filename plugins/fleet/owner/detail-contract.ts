// Owner detail contract: routes, verified capabilities, providers, MCP,
// editor links and the enrolled-host binding proof for one machine.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { providerAvailabilitySchema } from "../model";
import { hostCapabilitiesSchema } from "./capabilities";
import { hostBindingSchema } from "./host-identity";
import { projectOwnerTargetSchema } from "./project-contract";

export const ownerDetailSchema = z.object({
  machine: z.string(),
  owner: z.object({ serverId: z.string(), hostId: z.string().nullable(), url: z.string().nullable(), appVersion: z.string().nullable(), publishedAt: z.number() }).nullable(),
  routes: z.array(z.object({ kind: z.enum(["self", "ssh", "broker", "connect"]), state: z.enum(["healthy", "unavailable", "unconfigured"]), detail: z.string().nullable(), lastOkAt: z.number().nullable() })),
  activeRoute: z.enum(["self", "ssh", "broker", "none"]),
  capabilities: hostCapabilitiesSchema.nullable(),
  providers: z.array(providerAvailabilitySchema).nullable(),
  mcp: z.object({ installed: z.boolean(), enabled: z.boolean(), endpoint: z.string().nullable() }).nullable(),
  editorLinks: z.array(z.object({ projectId: z.string(), name: z.string(), url: z.string() })),
  binding: hostBindingSchema,
  projects: z.array(z.object({ id: z.string(), name: z.string(), path: z.string().nullable() })).max(200),
  terminal: z.object({ sshAlias: z.string().nullable(), sshVerified: z.boolean(), localHostId: z.string().nullable() }),
});
export type OwnerDetail = z.infer<typeof ownerDetailSchema>;

const machine = z.object({ machine: z.string().min(1).max(40) }).strict();
export const ownerDetailRpcContract = defineRpcContract({
  owner_detail_get: { input: machine, output: ownerDetailSchema },
  host_binding_get: { input: machine, output: hostBindingSchema },
  owner_project_target_get: { input: machine, output: projectOwnerTargetSchema },
  mcp_enable: { input: z.object({ enabled: z.boolean() }).strict(), output: z.object({ installed: z.boolean(), enabled: z.boolean(), endpoint: z.string().nullable() }) },
});
