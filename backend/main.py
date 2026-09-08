import logging
import os
import re
import datetime
from decimal import Decimal
from typing import List, Optional

import boto3
import requests
from boto3.dynamodb.conditions import Key
from cachetools import TTLCache
from fastapi import FastAPI, Depends, HTTPException, Header, Path, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from jose import jwt as jose_jwt, ExpiredSignatureError, JWTError
from pydantic import BaseModel, field_validator
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="StreamVault API")

# ── Security Headers Middleware ──

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Inject hardened security headers on every response."""

    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: https:; "
            "font-src 'self'; "
            "connect-src 'self' http://localhost:8000; "
            "frame-ancestors 'none'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        return response

app.add_middleware(SecurityHeadersMiddleware)

# ── DynamoDB Client Setup ──

TABLE_NAME = os.getenv("DYNAMODB_TABLE_NAME", "StreamVaultPlaybackProgress")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
table = dynamodb.Table(TABLE_NAME)

# ── Configure Strict CORS ──

VIEWER_DOMAIN = os.getenv("VIEWER_DOMAIN", "")
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
]
if VIEWER_DOMAIN:
    domain_url = VIEWER_DOMAIN if VIEWER_DOMAIN.startswith("http") else f"https://{VIEWER_DOMAIN}"
    ALLOWED_ORIGINS.append(domain_url)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# ── Cognito JWKS Configuration ──

COGNITO_USER_POOL_ID = os.getenv("COGNITO_USER_POOL_ID", "")
COGNITO_CLIENT_ID = os.getenv("COGNITO_CLIENT_ID", "")
COGNITO_REGION = os.getenv("COGNITO_REGION", AWS_REGION)

# Cache JWKS keys for 1 hour (Cognito rotates keys infrequently)
_jwks_cache: TTLCache = TTLCache(maxsize=1, ttl=3600)


def _get_cognito_jwks() -> dict:
    """Fetch and cache the Cognito User Pool's JWKS (JSON Web Key Set)."""
    cache_key = "jwks"
    if cache_key in _jwks_cache:
        return _jwks_cache[cache_key]

    if not COGNITO_USER_POOL_ID:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="COGNITO_USER_POOL_ID is not configured",
        )

    jwks_url = (
        f"https://cognito-idp.{COGNITO_REGION}.amazonaws.com"
        f"/{COGNITO_USER_POOL_ID}/.well-known/jwks.json"
    )
    try:
        resp = requests.get(jwks_url, timeout=5)
        resp.raise_for_status()
        jwks = resp.json()
    except Exception as e:
        logger.error(f"Failed to fetch Cognito JWKS from {jwks_url}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unable to fetch Cognito signing keys",
        )

    _jwks_cache[cache_key] = jwks
    return jwks


def _get_cognito_issuer() -> str:
    """Return the expected token issuer URL for this Cognito User Pool."""
    return f"https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{COGNITO_USER_POOL_ID}"

# ── Pydantic Schemas ──

MOVIE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")

# Maximum playback position in seconds (24 hours).
MAX_SECONDS = 86400.0

class ProgressUpdate(BaseModel):
    movie_id: str
    seconds: float

    @field_validator("movie_id")
    @classmethod
    def validate_movie_id(cls, v: str) -> str:
        if len(v) > 128:
            raise ValueError("movie_id exceeds maximum length of 128 characters")
        if not MOVIE_ID_PATTERN.match(v):
            raise ValueError("movie_id contains invalid characters")
        return v

    @field_validator("seconds")
    @classmethod
    def validate_seconds(cls, v: float) -> float:
        """Reject non-finite values and clamp to [0, MAX_SECONDS] (CWE-400)."""
        import math
        if not math.isfinite(v):
            raise ValueError("seconds must be a finite number")
        if v < 0.0:
            raise ValueError("seconds must not be negative")
        if v > MAX_SECONDS:
            raise ValueError(f"seconds exceeds maximum of {MAX_SECONDS}")
        return v

class ProgressResponse(BaseModel):
    movie_id: str
    seconds: float
    updated_at: str

class PaginatedHistoryResponse(BaseModel):
    items: List[ProgressResponse]
    next_token: Optional[str] = None

# ── Pagination Constants ──

HISTORY_DEFAULT_LIMIT = 50
HISTORY_MAX_LIMIT = 100

# ── Authentication Dependency ──

def get_current_user(
    authorization: str = Header(None)
) -> str:
    """Verify a Cognito-issued RS256 JWT and return the user identifier.

    Validates the token against the Cognito User Pool's JWKS endpoint,
    checks the issuer, audience (client_id), and token_use claims.
    Rejects unauthenticated requests with 401.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    token = authorization.split(" ", 1)[1]
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Empty token")

    if not COGNITO_USER_POOL_ID or not COGNITO_CLIENT_ID:
        logger.error("Cognito configuration is incomplete: COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Auth provider not configured")

    jwks = _get_cognito_jwks()

    # Extract the key ID from the token header to find the matching public key
    try:
        unverified_header = jose_jwt.get_unverified_header(token)
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token header")

    kid = unverified_header.get("kid")
    if not kid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token missing key ID")

    # Find the matching key in the JWKS
    rsa_key = None
    for key in jwks.get("keys", []):
        if key.get("kid") == kid:
            rsa_key = key
            break

    if not rsa_key:
        # Key not found — possibly rotated. Clear cache and retry once.
        _jwks_cache.clear()
        jwks = _get_cognito_jwks()
        for key in jwks.get("keys", []):
            if key.get("kid") == kid:
                rsa_key = key
                break

    if not rsa_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token signed with unknown key")

    issuer = _get_cognito_issuer()
    try:
        claims = jose_jwt.decode(
            token,
            rsa_key,
            algorithms=["RS256"],
            audience=COGNITO_CLIENT_ID,
            issuer=issuer,
            options={"require_exp": True, "require_sub": True},
        )
    except ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except JWTError as e:
        logger.warning(f"Cognito JWT verification failed: {e}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    # Cognito ID tokens have token_use=id; access tokens have token_use=access.
    # Only accept ID tokens for this API (matches the auth Lambda's verification).
    token_use = claims.get("token_use")
    if token_use != "id":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Expected an ID token")

    user_id = claims.get("sub") or claims.get("email")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token missing user identity")
    return user_id

# ── Endpoints ──

@app.post("/api/progress")
def save_progress(
    progress_in: ProgressUpdate,
    user_id: str = Depends(get_current_user)
):
    now_iso = datetime.datetime.utcnow().isoformat()
    try:
        table.put_item(
            Item={
                "user_id": user_id,
                "movie_id": progress_in.movie_id,
                "seconds": Decimal(str(round(progress_in.seconds, 2))),
                "updated_at": now_iso,
            }
        )
        return {"status": "success", "seconds": progress_in.seconds}
    except Exception as e:
        logger.exception("DynamoDB save_progress error")
        raise HTTPException(status_code=503, detail="Failed to save progress")

@app.get("/api/progress/{movie_id}")
def get_progress(
    movie_id: str = Path(..., pattern=r"^[a-zA-Z0-9_-]+$", max_length=128),
    user_id: str = Depends(get_current_user)
):
    try:
        response = table.get_item(
            Key={
                "user_id": user_id,
                "movie_id": movie_id,
            }
        )
        item = response.get("Item")
        if not item:
            return {"seconds": 0.0}
        return {"seconds": float(item.get("seconds", 0.0))}
    except Exception as e:
        logger.exception("DynamoDB get_progress error")
        raise HTTPException(status_code=503, detail="Failed to retrieve progress")

@app.get("/api/history", response_model=PaginatedHistoryResponse)
def get_history(
    limit: int = HISTORY_DEFAULT_LIMIT,
    next_token: Optional[str] = None,
    user_id: str = Depends(get_current_user)
):
    # Clamp limit to [1, HISTORY_MAX_LIMIT] (CWE-400)
    limit = max(1, min(limit, HISTORY_MAX_LIMIT))

    try:
        query_kwargs = dict(
            IndexName="UserUpdatedAtIndex",
            KeyConditionExpression=Key("user_id").eq(user_id),
            ScanIndexForward=False,
            Limit=limit,
        )
        if next_token:
            import json, base64
            try:
                query_kwargs["ExclusiveStartKey"] = json.loads(
                    base64.urlsafe_b64decode(next_token)
                )
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid next_token")

        response = table.query(**query_kwargs)
        items = response.get("Items", [])
        result = [
            ProgressResponse(
                movie_id=item["movie_id"],
                seconds=float(item.get("seconds", 0.0)),
                updated_at=str(item.get("updated_at", "")),
            )
            for item in items
        ]

        # Build opaque cursor from DynamoDB's LastEvaluatedKey
        result_next_token = None
        last_key = response.get("LastEvaluatedKey")
        if last_key:
            import json, base64
            result_next_token = base64.urlsafe_b64encode(
                json.dumps(last_key, default=str).encode()
            ).decode()

        return PaginatedHistoryResponse(items=result, next_token=result_next_token)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("DynamoDB get_history error")
        raise HTTPException(status_code=503, detail="Failed to retrieve history")
