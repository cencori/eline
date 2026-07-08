import { defineAgent } from "arcie";
import { cencori } from "arcie/models";

export default defineAgent({
  model: cencori("claude-sonnet-4-5"),
  name: "my-agent",
  description: "An Arcie agent powered by Cencori.",
  cencori: {
    project: process.env.CENCORI_PROJECT_ID,
    billing: {
      budget: "50.00/month",
    },
  },
});
