declare module "cytoscape-dagre" {
  import type cytoscape from "cytoscape";

  const extension: (cy: typeof cytoscape) => void;

  export default extension;
}
