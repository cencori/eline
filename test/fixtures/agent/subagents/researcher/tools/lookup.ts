export default {
  description: "Look up a term and return a stub definition.",
  execute: ({ term }: { term: string }) => ({ term, definition: `stub: ${term}` }),
};
