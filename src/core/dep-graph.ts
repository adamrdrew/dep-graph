import * as _ from 'lodash';
import * as graphlib from 'graphlib';
import * as types from './types';
import {createFromJSON} from './create-from-json';

export {
  DepGraphImpl,
};

interface GraphNode {
  pkgId: string;
  info?: types.NodeInfo;
}

class DepGraphImpl implements types.DepGraphInternal {
  public static SCHEMA_VERSION = '1.2.0';

  public static getPkgId(pkg: types.Pkg): string {
    return `${pkg.name}@${pkg.version || ''}`;
  }

  private _pkgs: { [pkgId: string]: types.PkgInfo };
  private _pkgNodes: { [pkgId: string]: Set<string> };

  private _pkgList: types.PkgInfo[];
  private _depPkgsList: types.PkgInfo[];

  private _graph: graphlib.Graph;
  private _pkgManager: types.PkgManager;

  private _rootNodeId: string;
  private _rootPkgId: string;

  private _countNodePathsToRootCache: Map<string, number> = new Map();

  private _hasCycles: boolean | undefined;

  public constructor(
    graph: graphlib.Graph,
    rootNodeId: string,
    pkgs: { [pkgId: string]: types.PkgInfo },
    pkgNodes: { [pkgId: string]: Set<string> },
    pkgManager: types.PkgManager,
  ) {
    this._graph = graph;
    this._pkgs = pkgs;
    this._pkgNodes = pkgNodes;
    this._pkgManager = pkgManager;

    this._rootNodeId = rootNodeId;
    this._rootPkgId = (graph.node(rootNodeId) as GraphNode).pkgId;

    this._pkgList = _.values(pkgs);
    this._depPkgsList = this._pkgList
      .filter((pkg) => pkg !== this.rootPkg);
  }

  get pkgManager() {
    return this._pkgManager;
  }

  get rootPkg(): types.PkgInfo {
    return this._pkgs[this._rootPkgId];
  }

  get rootNodeId(): string {
    return this._rootNodeId;
  }

  public getPkgs(): types.PkgInfo[] {
    return this._pkgList;
  }

  public getDepPkgs(): types.PkgInfo[] {
    return this._depPkgsList;
  }

  public getPkgNodes(pkg: types.Pkg): types.Node[] {
    const pkgId = DepGraphImpl.getPkgId(pkg);

    const nodes: types.Node[] = [];
    for (const nodeId of Array.from(this._pkgNodes[pkgId])) {
      const graphNode = this.getGraphNode(nodeId);

      nodes.push({
        info: graphNode.info || {},
      });
    }

    return nodes;
  }

  public getNode(nodeId: string): types.NodeInfo {
    return this.getGraphNode(nodeId).info || {};
  }

  public getNodePkg(nodeId: string): types.PkgInfo {
    return this._pkgs[this.getGraphNode(nodeId).pkgId];
  }

  public getPkgNodeIds(pkg: types.Pkg): string[] {
    const pkgId = DepGraphImpl.getPkgId(pkg);

    if (!this._pkgs[pkgId]) {
      throw new Error(`no such pkg: ${pkgId}`);
    }

    return Array.from(this._pkgNodes[pkgId]);
  }

  public getNodeDepsNodeIds(nodeId: string): string[] {
    const deps = this._graph.successors(nodeId);
    if (!deps) {
      throw new Error(`no such node: ${nodeId}`);
    }
    return deps;
  }

  public getNodeParentsNodeIds(nodeId: string): string[] {
    const parents = this._graph.predecessors(nodeId);
    if (!parents) {
      throw new Error(`no such node: ${nodeId}`);
    }
    return parents;
  }

  public hasCycles(): boolean {
    // `isAcyclic` is expensive, so memoize
    if (this._hasCycles === undefined) {
      this._hasCycles = !graphlib.alg.isAcyclic(this._graph);
    }
    return this._hasCycles;
  }

  public pkgPathsToRoot(pkg: types.Pkg): types.PkgInfo[][] {
    // TODO: implement cycles support
    if (this.hasCycles()) {
      throw new Error('pkgPathsToRoot does not support cyclic graphs yet');
    }

    const pathsToRoot: types.PkgInfo[][] = [];
    for (const id of this.getPkgNodeIds(pkg)) {
      const paths = this.pathsFromNodeToRoot(id);
      for (const path of paths) {
        pathsToRoot.push(path);
      }
    }
    // note: sorting to get shorter paths first -
    //  it's nicer - and better resembles older behaviour
    return pathsToRoot.sort((a, b) => a.length - b.length);
  }

  public countPathsToRoot(pkg: types.Pkg): number {
    // TODO: implement cycles support
    if (this.hasCycles()) {
      throw new Error('countPathsToRoot does not support cyclic graphs yet');
    }

    let count = 0;
    for (const nodeId of this.getPkgNodeIds(pkg)) {
      count += this.countNodePathsToRoot(nodeId);
    }

    return count;
  }

  public equals(other: types.DepGraph, { compareRoot = true }: { compareRoot?: boolean } = {}): boolean {
    let otherDepGraph;

    if (other instanceof DepGraphImpl) {
      otherDepGraph = other as types.DepGraphInternal;
    } else {
      // At runtime theoretically we can have multiple versions of
      // @snyk/dep-graph. If "other" is not an instance of the same class it is
      // safer to rebuild it from JSON.
      otherDepGraph = createFromJSON(other.toJSON()) as types.DepGraphInternal;
    }

    // In theory, for the graphs created by standard means, `_.isEquals(this._data, otherDepGraph._data)`
    // should suffice, since node IDs will be generated in a predictable way.
    // However, there might be different versions of graph and inconsistencies
    // in the ordering of the arrays, so we perform a deep comparison.
    return this.nodeEquals(this, this.rootNodeId, otherDepGraph, otherDepGraph.rootNodeId, compareRoot);
  }

  public toJSON(): types.DepGraphData {
    const nodeIds = this._graph.nodes();

    const nodes = nodeIds.reduce((acc: types.GraphNode[], nodeId: string) => {
      const deps = (this._graph.successors(nodeId) || [])
        .map((depNodeId) => ({ nodeId: depNodeId }));

      const node = this._graph.node(nodeId) as GraphNode;
      const elem: types.GraphNode = {
        nodeId,
        pkgId: node.pkgId,
        deps,
      };
      if (!_.isEmpty(node.info)) {
        elem.info = node.info;
      }
      acc.push(elem);
      return acc;
    }, []);

    const pkgs: Array<{ id: string; info: types.PkgInfo; }> = _.keys(this._pkgs)
      .map((pkgId: string) => ({
        id: pkgId,
        info: this._pkgs[pkgId],
      }));

    return {
      schemaVersion: DepGraphImpl.SCHEMA_VERSION,
      pkgManager: this._pkgManager,
      pkgs,
      graph: {
        rootNodeId: this._rootNodeId,
        nodes,
      },
    };
  }

  private nodeEquals(
    graphA: types.DepGraphInternal,
    nodeIdA: string,
    graphB: types.DepGraphInternal,
    nodeIdB: string,
    compareRoot: boolean,
    traversedPairs = new Set<string>(),
  ): boolean {
    // Skip root nodes comparision if needed.
    if (compareRoot || (nodeIdA !== graphA.rootNodeId && nodeIdB !== graphB.rootNodeId)) {
      const pkgA = graphA.getNodePkg(nodeIdA);
      const pkgB = graphB.getNodePkg(nodeIdB);

      // Compare PkgInfo (name and version).
      if (!_.isEqual(pkgA, pkgB)) {
        return false;
      }

      const infoA = graphA.getNode(nodeIdA);
      const infoB = graphB.getNode(nodeIdB);

      // Compare NodeInfo (VersionProvenance and labels).
      if (!_.isEqual(infoA, infoB)) {
        return false;
      }
    }

    let depsA = graphA.getNodeDepsNodeIds(nodeIdA);
    let depsB = graphB.getNodeDepsNodeIds(nodeIdB);

    // Number of dependencies should be the same.
    if (depsA.length !== depsB.length) {
      return false;
    }

    // Sort dependencies by name@version string.
    const sortFn = (graph: types.DepGraphInternal) => (idA: string, idB: string) => {
      const pkgA = graph.getNodePkg(idA);
      const pkgB = graph.getNodePkg(idB);
      return DepGraphImpl.getPkgId(pkgA).localeCompare(DepGraphImpl.getPkgId(pkgB));
    };

    depsA = depsA.sort(sortFn(graphA));
    depsB = depsB.sort(sortFn(graphB));

    // Compare Each dependency recursively.
    for (let i = 0; i < depsA.length; i++) {
      const pairKey = `${depsA[i]}_${depsB[i]}`;

      // Prevent cycles.
      if (traversedPairs.has(pairKey)) {
        continue;
      }

      traversedPairs.add(pairKey);

      if (!this.nodeEquals(graphA, depsA[i], graphB, depsB[i], compareRoot, traversedPairs)) {
        return false;
      }
    }

    return true;
  }

  private getGraphNode(nodeId: string): GraphNode {
    const node = this._graph.node(nodeId) as GraphNode;
    if (!node) {
      throw new Error(`no such node: ${nodeId}`);
    }
    return node;
  }

  private pathsFromNodeToRoot(nodeId: string): types.PkgInfo[][] {
    const parentNodesIds = this.getNodeParentsNodeIds(nodeId);
    if (parentNodesIds.length === 0) {
      return [[this.getNodePkg(nodeId)]];
    }

    const allPaths: types.PkgInfo[][] = [];
    parentNodesIds.map((id) => {
      const out = this.pathsFromNodeToRoot(id).map((path) => {
        return [this.getNodePkg(nodeId)].concat(path);
      });
      for (const path of out) {
        allPaths.push(path);
      }
    });

    return allPaths;
  }

  private countNodePathsToRoot(nodeId: string): number {
    if (this._countNodePathsToRootCache.has(nodeId)) {
      return this._countNodePathsToRootCache.get(nodeId) || 0;
    }

    const parentNodesIds = this.getNodeParentsNodeIds(nodeId);
    if (parentNodesIds.length === 0) {
      this._countNodePathsToRootCache.set(nodeId, 1);
      return 1;
    }

    const count = parentNodesIds.reduce((acc, parentNodeId) => {
      return acc + this.countNodePathsToRoot(parentNodeId);
    }, 0);

    this._countNodePathsToRootCache.set(nodeId, count);
    return count;
  }
}
