import { makePipelineWorkflow } from "../../src/workflow";
import { registry } from "./registry";

export const pipelineWorkflow = makePipelineWorkflow(registry);
