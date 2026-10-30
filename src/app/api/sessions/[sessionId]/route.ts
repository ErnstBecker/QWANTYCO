import {
  assistantParam,
  handleDeleteSession,
  handleGetSession,
  withRuntime,
} from "@/server/http/handlers";
import { getRuntime } from "@/server/runtime";

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/sessions/[sessionId]">,
) {
  const { sessionId } = await ctx.params;
  return withRuntime(getRuntime, (service) =>
    handleGetSession(sessionId, service, assistantParam(request)),
  );
}

export async function DELETE(
  request: Request,
  ctx: RouteContext<"/api/sessions/[sessionId]">,
) {
  const { sessionId } = await ctx.params;
  return withRuntime(getRuntime, (service) =>
    handleDeleteSession(sessionId, service, assistantParam(request)),
  );
}
