import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARCIE_URL = process.env.ARCIE_URL ?? "http://localhost:3000";

export async function GET(_req: NextRequest) {
  try {
    const upstream = await fetch(`${ARCIE_URL}/agents`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!upstream.ok) {
      return Response.json(
        { error: `Upstream ${upstream.status}`, agents: [] },
        { status: upstream.status },
      );
    }
    const agents = (await upstream.json()) as Array<{
      id: string;
      name: string;
      model: string;
      description: string;
    }>;
    return Response.json(agents);
  } catch (error) {
    return Response.json(
      {
        error: "Could not reach arcie server",
        detail: error instanceof Error ? error.message : String(error),
        hint: `Is arcie running at ${ARCIE_URL}? Start it with \`arcie dev\`.`,
        agents: [],
      },
      { status: 502 },
    );
  }
}
