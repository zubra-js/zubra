"""Run the garden: `python app.py` (http://localhost:5000)."""
import os

from garden import create_app
from garden.hosted import from_env

# HOSTED_DEMO=1: a public demo, capped and reset daily (garden/hosted.py).
app = create_app(cache=os.environ.get("FLASK_DEBUG") != "1", hosted=from_env(os.environ))

if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5000)), debug=os.environ.get("FLASK_DEBUG") == "1")
