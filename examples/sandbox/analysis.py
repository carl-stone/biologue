# A synthetic workspace example, not biological evidence.
# Run this file, then inspect the environment or reuse `measurements` in the console.
import pandas as pd
import matplotlib.pyplot as plt

measurements = pd.DataFrame({
    "sample": ["A", "B", "C", "D", "E", "F"],
    "signal": [2.4, 3.1, 2.8, 4.2, 3.8, 4.5],
})

fig, ax = plt.subplots(figsize=(6, 3.5))
ax.plot(measurements["sample"], measurements["signal"], "o-", color="#497e75")
ax.set(xlabel="Sample", ylabel="Signal (arbitrary units)", title="Synthetic measurements")
fig.tight_layout()
plt.show()
measurements
