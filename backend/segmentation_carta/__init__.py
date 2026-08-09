# CartaPipeline deliberately NOT imported here (unlike CartaConfig) - unlike
# .llm (segmentation_carta.llm, which server.py needs unconditionally for
# the live /paper/storyboard route's CartaLLMClient), .pipeline imports
# spacy at module level, real memory a package-level re-export would force
# on that unconditional import too. Import it directly from
# segmentation_carta.pipeline where actually needed (server.py's own lazy
# _get_carta_pipeline()).
from .config import CartaConfig

__all__ = ['CartaConfig']
