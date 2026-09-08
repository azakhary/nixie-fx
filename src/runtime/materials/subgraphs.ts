import type {
  MaterialEdge,
  MaterialNode,
  ShaderGraph,
} from "../schema/materials";

/** Inline portable subgraph snapshots before tier analysis, baking or GLSL compilation. */
export function expandMaterialSubgraphs(
  graph: ShaderGraph,
  ancestors: readonly string[] = [],
): ShaderGraph {
  if (!graph.nodes.some((node) => node.type === "subgraph")) return graph;
  if (ancestors.length >= 32 || ancestors.includes(graph.id)) {
    throw new Error(
      `Recursive material subgraph: ${[...ancestors, graph.id].join(" → ")}`,
    );
  }
  let result = {
    ...graph,
    nodes: [...graph.nodes],
    edges: [...graph.edges],
    params: [...graph.params],
  };
  for (const instance of graph.nodes.filter(
    (node) => node.type === "subgraph",
  )) {
    const definition = instance.params.graph as ShaderGraph | undefined;
    if (!definition?.subgraph)
      throw new Error(`Missing subgraph definition for ${instance.id}`);
    const inner = expandMaterialSubgraphs(definition, [...ancestors, graph.id]);
    const prefix = `${instance.id}/`;
    const nodeId = (id: string) => prefix + id;
    const edgeId = (id: string) => prefix + id;
    const bindings = new Map<string, MaterialEdge>();
    for (const param of definition.params) {
      const edge = result.edges.find(
        (e) => e.id === instance.inputs[param.inputId ?? param.name],
      );
      if (edge) bindings.set(param.name, edge);
    }
    const resolve = (
      id: string,
      handle: string,
    ): { source: string; sourceHandle: string } => {
      const source = inner.nodes.find((n) => n.id === id);
      const bound =
        source?.type === "param"
          ? bindings.get(String(source.params.name))
          : undefined;
      return bound
        ? { source: bound.source, sourceHandle: bound.sourceHandle }
        : { source: nodeId(id), sourceHandle: handle };
    };
    const nodes: MaterialNode[] = inner.nodes
      .filter((n) => n.type !== "output")
      .map((node) => ({
        ...node,
        id: nodeId(node.id),
        inputs: Object.fromEntries(
          Object.entries(node.inputs).map(([pin, edge]) => [
            pin,
            edge ? edgeId(edge) : null,
          ]),
        ),
        params:
          node.type === "param"
            ? { ...node.params, name: prefix + String(node.params.name) }
            : { ...node.params },
      }));
    const edges = inner.edges
      .filter(
        (e) => inner.nodes.find((n) => n.id === e.target)?.type !== "output",
      )
      .map((edge) => ({
        ...edge,
        ...resolve(edge.source, edge.sourceHandle),
        id: edgeId(edge.id),
        target: nodeId(edge.target),
      }));
    const parentEdges = result.edges
      .filter((edge) => edge.target !== instance.id)
      .map((edge) => {
        if (edge.source !== instance.id) return edge;
        const output = inner.subgraph!.outputs.find(
          (p) => p.id === edge.sourceHandle,
        );
        if (!output || !inner.nodes.some((n) => n.id === output.nodeId))
          throw new Error(
            `Missing output ${edge.sourceHandle} in subgraph ${definition.name}`,
          );
        return { ...edge, ...resolve(output.nodeId, output.handle) };
      });
    result = {
      ...result,
      subgraph: result.subgraph
        ? {
            outputs: result.subgraph.outputs.map((output) => {
              if (output.nodeId !== instance.id) return output;
              const exposed = inner.subgraph!.outputs.find(
                (p) => p.id === output.handle,
              );
              if (!exposed)
                throw new Error(
                  `Missing output ${output.handle} in subgraph ${definition.name}`,
                );
              const resolved = resolve(exposed.nodeId, exposed.handle);
              return {
                ...output,
                nodeId: resolved.source,
                handle: resolved.sourceHandle,
              };
            }),
          }
        : undefined,
      nodes: [...result.nodes.filter((n) => n.id !== instance.id), ...nodes],
      edges: [...parentEdges, ...edges],
      params: [
        ...result.params,
        ...inner.params.map((p) => ({
          ...p,
          name: prefix + p.name,
          builtinRole: undefined,
        })),
      ],
    };
  }
  return result;
}
