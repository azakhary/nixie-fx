#!/usr/bin/env node

import { runNixieFxCli } from "./index";

void runNixieFxCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
