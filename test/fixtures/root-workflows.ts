// A workflows file that imports the registry the way an app does: from the package root
// (`@fauzanqadri/factory`). bundle.test.ts bundles it to keep the root sandbox-safe.
import { createRegistry } from "../../src/index";
import { makePipelineWorkflow } from "../../src/workflow";

export const pipelineWorkflow = makePipelineWorkflow(createRegistry());
