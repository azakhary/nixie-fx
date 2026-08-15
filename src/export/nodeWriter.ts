import { nodeExportIo } from "./nodeExportIo";
import {
  writeVfxExportWithIo,
  type WriteVfxExportFromProjectOptions,
} from "./writer";
import type { VfxExportWriteResult } from "./schema";

/** Node entry point for the export pipeline (dev server middleware + tests). */
export function writeVfxExportFromProject(
  options: WriteVfxExportFromProjectOptions,
): Promise<VfxExportWriteResult> {
  return writeVfxExportWithIo(options, nodeExportIo);
}
