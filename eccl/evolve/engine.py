"""The evolutionary engine: a tournament-selection genetic algorithm.

Generic over genome type; wired for molecules out of the box. Supports
elitism, tournament selection, mutation + crossover, an optional novelty
archive to fight premature convergence, and an optional *gate* callback
(the harsh critics gate) that can veto individuals before they reproduce.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from ..core.molecule import have_rdkit
from . import operators
from .fitness import Objective
from .genome import SEED_SMILES, MoleculeGenome


@dataclass
class EvolutionConfig:
    population_size: int = 40
    generations: int = 20
    elitism: int = 2
    tournament_size: int = 3
    mutation_rate: float = 0.6
    crossover_rate: float = 0.4
    random_seed: int | None = None
    dedupe: bool = True
    patience: int = 0           # early stop if no improvement for N gens (0=off)


@dataclass
class Individual:
    genome: MoleculeGenome
    fitness: float = 0.0
    details: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"smiles": self.genome.smiles, "fitness": round(self.fitness, 5),
                "generation": self.genome.generation, "details": self.details}


@dataclass
class EvolutionResult:
    best: Individual
    hall_of_fame: list[Individual]
    history: list[dict[str, float]]   # per-generation stats
    evaluations: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "best": self.best.as_dict(),
            "hall_of_fame": [i.as_dict() for i in self.hall_of_fame],
            "history": self.history,
            "evaluations": self.evaluations,
        }


# A gate takes a candidate SMILES and returns True to allow it, False to veto.
Gate = Callable[[MoleculeGenome], bool]


class MolecularEvolver:
    def __init__(self, objective: Objective, config: EvolutionConfig | None = None,
                 gate: Optional[Gate] = None) -> None:
        self.objective = objective
        self.config = config or EvolutionConfig()
        self.gate = gate
        self.rng = random.Random(self.config.random_seed)
        self._cache: dict[str, float] = {}
        self._evaluations = 0

    # ---- evaluation ----
    def _evaluate(self, genome: MoleculeGenome) -> float:
        key = genome.smiles
        if key in self._cache:
            return self._cache[key]
        try:
            fit = float(self.objective(genome))
        except Exception:
            fit = 0.0
        self._cache[key] = fit
        self._evaluations += 1
        return fit

    # ---- seeding ----
    def _seed_population(self, seeds: list[str] | None) -> list[Individual]:
        smis = list(seeds) if seeds else list(SEED_SMILES)
        pop: list[Individual] = []
        i = 0
        while len(pop) < self.config.population_size:
            smi = smis[i % len(smis)]
            g = MoleculeGenome(smi, generation=0)
            if g.is_valid() and (self.gate is None or self.gate(g)):
                pop.append(Individual(g, self._evaluate(g)))
            i += 1
            if i > self.config.population_size * 20:
                break
        if not pop:
            raise RuntimeError("could not seed any valid individuals")
        # pad if gate was very strict
        while len(pop) < self.config.population_size:
            pop.append(Individual(pop[0].genome, pop[0].fitness))
        return pop

    # ---- selection ----
    def _tournament(self, pop: list[Individual]) -> Individual:
        contenders = self.rng.sample(pop, min(self.config.tournament_size, len(pop)))
        return max(contenders, key=lambda ind: ind.fitness)

    # ---- main loop ----
    def run(self, seeds: list[str] | None = None,
            on_generation: Callable[[int, list[Individual]], None] | None = None,
            ) -> EvolutionResult:
        cfg = self.config
        pop = self._seed_population(seeds)
        pop.sort(key=lambda i: i.fitness, reverse=True)
        hof: list[Individual] = []
        history: list[dict[str, float]] = []
        best_so_far = pop[0].fitness
        stale = 0

        for gen in range(1, cfg.generations + 1):
            next_pop: list[Individual] = pop[: cfg.elitism]  # elitism
            seen = {ind.genome.smiles for ind in next_pop}

            guard = 0
            while len(next_pop) < cfg.population_size:
                guard += 1
                if guard > cfg.population_size * 50:
                    break
                child_genome: MoleculeGenome
                if self.rng.random() < cfg.crossover_rate and len(pop) >= 2:
                    pa, pb = self._tournament(pop), self._tournament(pop)
                    child_genome = operators.crossover_molecules(
                        pa.genome, pb.genome, self.rng)
                else:
                    parent = self._tournament(pop)
                    child_genome = parent.genome

                if self.rng.random() < cfg.mutation_rate:
                    child_genome = operators.mutate_molecule(child_genome, self.rng)

                if not child_genome.is_valid():
                    continue
                canon = child_genome.smiles
                if cfg.dedupe and canon in seen:
                    continue
                if self.gate is not None and not self.gate(child_genome):
                    continue
                fit = self._evaluate(child_genome)
                next_pop.append(Individual(child_genome, fit))
                seen.add(canon)

            pop = sorted(next_pop, key=lambda i: i.fitness, reverse=True)
            pop = pop[: cfg.population_size]

            # hall of fame (unique best)
            for ind in pop[:5]:
                if ind.genome.smiles not in {h.genome.smiles for h in hof}:
                    hof.append(ind)
            hof.sort(key=lambda i: i.fitness, reverse=True)
            hof = hof[:10]

            fits = [i.fitness for i in pop]
            stats = {"generation": gen, "best": round(max(fits), 5),
                     "mean": round(sum(fits) / len(fits), 5),
                     "worst": round(min(fits), 5),
                     "unique": len({i.genome.smiles for i in pop})}
            history.append(stats)
            if on_generation:
                on_generation(gen, pop)

            if max(fits) > best_so_far + 1e-9:
                best_so_far = max(fits)
                stale = 0
            else:
                stale += 1
            if cfg.patience and stale >= cfg.patience:
                break

        return EvolutionResult(best=hof[0] if hof else pop[0],
                               hall_of_fame=hof, history=history,
                               evaluations=self._evaluations)
