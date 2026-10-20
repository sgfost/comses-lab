import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    from model import simulate
    return mo, simulate


@app.cell
def _(mo):
    mo.md("## Population experiment\nChange the growth rate to rerun the model.")
    return


@app.cell
def _(mo):
    growth = mo.ui.slider(0.05, 0.5, step=0.05, value=0.2, label="Growth rate")
    growth
    return (growth,)


@app.cell
def _(growth, mo, simulate):
    values = simulate(growth.value)
    points = " ".join(f"{i * 16},{170 - value * 1.5}" for i, value in enumerate(values))
    mo.vstack([
        mo.Html(f'<svg viewBox="0 0 500 190" role="img" aria-label="Population over time"><polyline points="{points}" fill="none" stroke="#176b63" stroke-width="3" /></svg>'),
        mo.md(f"Final population: **{values[-1]:.1f}**"),
    ])
    return


if __name__ == "__main__":
    app.run()
