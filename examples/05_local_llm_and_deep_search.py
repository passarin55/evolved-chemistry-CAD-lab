"""Example 5 — wire in a local LLM and run a grounded deep search.

Run a local model first (examples):
    ollama serve && ollama pull llama3.1
    #  or LM Studio / llama.cpp server on :1234

Then:
    ECCL_LLM_BACKEND=ollama ECCL_LLM_MODEL=llama3.1 \
        python examples/05_local_llm_and_deep_search.py

With no local model reachable, this still runs: it falls back to the offline
deterministic client and the deep search degrades to 'whatever providers
answered' (nothing, if egress is blocked).
"""
from eccl.llm import get_client, complete
from eccl.search import DeepSearch
from eccl.critics import CriticsGate, Harshness
from eccl.core import Molecule


def main() -> None:
    client = get_client()  # auto: ollama -> openai-compatible -> echo
    print(f"LLM backend in use: {client.name}")
    reachable = "echo" not in client.name
    print(f"local model reachable: {reachable}")

    print("\n== Deep search (multi-provider, grounded synthesis) ==")
    ds = DeepSearch(llm=client)
    report = ds.run("2D semiconductor transition metal dichalcogenide bandgap",
                    per_provider=3, synthesise=True)
    print(f"  providers used:   {report.providers_used}")
    print(f"  providers failed: {list(report.providers_failed)}")
    print(f"  results returned: {len(report.results)}")
    if report.synthesis:
        print(f"  synthesis:\n    {report.synthesis[:400]}")

    print("\n== LLM-assisted critics gate (devil's advocate) ==")
    gate = CriticsGate(Harshness.HARSH, llm=client, use_llm=reachable)
    verdict = gate.review_molecule(Molecule.from_smiles("O=C(O)c1ccccc1OC(C)=O"))
    print(f"  accepted: {verdict.accepted}  score: {verdict.score}")
    if verdict.llm_note:
        print(f"  llm reviewer note: {verdict.llm_note[:300]}")


if __name__ == "__main__":
    main()
