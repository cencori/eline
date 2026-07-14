import { defineAgent } from "arcie";

export default defineAgent({
  model: "llama-3.3-70b-versatile",
  name: "arcie-starter",
  description: "Full-featured agent with web search, file intelligence, code analysis, calculation, and deep research.",
  cencori: {
    billing: {
      budget: "50.00/month",
    },
  },
});
