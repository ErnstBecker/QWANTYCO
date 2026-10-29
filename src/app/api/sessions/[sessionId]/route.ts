import { handleGetSession, withRuntime } from "@/server/http/handlers";
import { getRuntime } from "@/server/runtime";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/sessions/[sessionId]">,
) {
  const { sessionId } = await ctx.params;
  return withRuntime(getRuntime, (service) =>
    handleGetSession(sessionId, service),
  );
}
