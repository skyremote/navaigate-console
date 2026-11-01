# Profile

The brain kit reads nothing from the NavAIgate Console profile. Its own settings
(database address, token files, ports) live in `.env`, copied from `.env.example`,
which is never committed. The Console's setup screen asks for the brain's address
and the name of the secret that holds its token; the token itself stays in bb's
secrets store or your environment.
