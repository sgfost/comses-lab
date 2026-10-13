# External observations

An ordinary HTML application with JavaScript and Python calculations, its own controls, and no Lab SDK. JavaScript fetches a JSON dataset in the page; Python fetches it with `pyodide.http.pyfetch` inside a browser worker. Both requests explicitly omit credentials.

Serve a JSON object such as `{ "values": [2, 4, 8] }` from a canonical HTTP(S) origin allowed in the project's data-origin metadata. The server must return `Access-Control-Allow-Origin: null`, or another CORS policy allowing the opaque runner. Enter the full dataset URL in the model. The initial data gives a JavaScript sum of 14 and a Python sum of squares of 84. Changing the dataset to `[3, 9, 12]` gives 24 and 234.

The pinned Python interpreter remains hosted by the runtime. Data permission permits fetches only, including in inherited blob workers; it does not allow loading code from the dataset origin. Allowed DNS names and their servers are trusted by the owner; this is not an intranet firewall. Arbitrary model fetches can request third-party credentials for an allowed origin, although this example omits them.
