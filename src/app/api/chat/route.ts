import { handleChat, withRuntime } from "@/server/http/handlers";
import { getRuntime } from "@/server/runtime";

export async function POST(request: Request) {
  return withRuntime(getRuntime, (service) => handleChat(request, service));
}
