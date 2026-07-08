"""Stage 7 continued: given a pairwise similarity function (similarity.py),
group items into candidate clusters via Union-Find over every pair whose
combined score clears a threshold. These are only *candidate* duplicate
groups - stage 8 (dedup.py) asks an LLM to confirm which items within a
candidate cluster are genuinely semantically equal, since Levenshtein +
embedding similarity alone can conflate merely-related items (e.g. "queen"
and "queen bee") with truly identical ones.
"""


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, x: int, y: int) -> None:
        rx, ry = self.find(x), self.find(y)
        if rx != ry:
            self.parent[rx] = ry


def cluster_by_similarity(items: list, pair_similarity_fn, threshold: float) -> list:
    """Return a list of clusters (each a list of original items), grouping
    every item transitively connected by a pairwise score >= threshold.
    An item with no similar match ends up as its own singleton cluster.
    `pair_similarity_fn(i, j)` takes two indices into `items`."""
    n = len(items)
    uf = _UnionFind(n)
    for i in range(n):
        for j in range(i + 1, n):
            if pair_similarity_fn(i, j) >= threshold:
                uf.union(i, j)

    groups = {}
    for i in range(n):
        groups.setdefault(uf.find(i), []).append(items[i])
    return list(groups.values())
