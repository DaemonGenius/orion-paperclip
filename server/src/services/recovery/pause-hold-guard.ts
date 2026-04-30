import type { Db } from "@paperclipai/db";
import { taskTreeControlService } from "../task-tree-control.js";

type TaskTreeControlService = ReturnType<typeof taskTreeControlService>;

export async function isAutomaticRecoverySuppressedByPauseHold(
  db: Db,
  companyId: string,
  taskId: string,
  treeControlSvc: TaskTreeControlService = taskTreeControlService(db),
) {
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, taskId);
  return Boolean(activePauseHold);
}
