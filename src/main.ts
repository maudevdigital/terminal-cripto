import { main } from "./server.ts";

main().catch((exc) => {
  console.error(exc);
  process.exit(1);
});
