import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARCIE_URL = process.env.ARCIE_URL ?? "http://localhost:3000";

export async function POST(req: NextRequest) {
  const { message, agentId } = (await req.json()) as {
    message: string;
    agentId?: string;
  };
  if (typeof message !== "string" || message.length === 0) {
    return new Response("message required", { status: 400 });
  }

  const target =
    typeof agentId === "string" && agentId.length > 0
      ? `${ARCIE_URL}/agents/${encodeURIComponent(agentId)}`
      : ARCIE_URL;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, stream: true }),
    });
  } catch (error) {
    return Response.json(
      {
        error: "Could not reach arcie server",
        detail: error instanceof Error ? error.message : String(error),
        hint: `Is arcie running at ${ARCIE_URL}? Start it with \`arcie dev\` in the agent directory.`,
      },
      { status: 502 },
    );
  }

  if (!upstream.ok || upstream.body === null) {
    return new Response(await upstream.text(), { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
