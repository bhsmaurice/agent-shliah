<?php
// Proxy public dédié aux lettres. Aucune clé Stripe secrète ni mot de passe admin ici.
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function fail_request(int $status, string $message): void {
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}
$action = $_GET['action'] ?? '';
$routes = ['config' => ['GET', 'config'], 'create' => ['POST', 'orders'], 'status' => ['POST', 'status'], 'receipt' => ['POST', 'receipt']];
if (!is_string($action) || !isset($routes[$action])) fail_request(404, 'Action inconnue.');
[$method, $route] = $routes[$action];
if (($_SERVER['REQUEST_METHOD'] ?? '') !== $method) fail_request(405, 'Méthode non autorisée.');
if (!function_exists('curl_init')) fail_request(503, 'L’extension PHP cURL est nécessaire.');
$body = '';
if ($method === 'POST') {
    if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 65536) fail_request(413, 'Formulaire trop volumineux.');
    $body = file_get_contents('php://input', false, null, 0, 65537);
    if ($body === false || strlen($body) > 65536) fail_request(413, 'Formulaire trop volumineux.');
    $decoded = json_decode($body, true);
    if (!is_array($decoded) || json_last_error() !== JSON_ERROR_NONE) fail_request(400, 'Formulaire invalide.');
}
// Destination fixe : ne jamais accepter une URL fournie par le navigateur.
$url = 'https://agent-shliah-production.up.railway.app/lettres-sefer-torah/api/' . $route;
$curl = curl_init($url);
curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 30, CURLOPT_FOLLOWLOCATION => false, CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Accept: application/json']]);
if ($method === 'POST') curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
$result = curl_exec($curl);
$status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
curl_close($curl);
if ($result === false || $status === 0) fail_request(502, 'Connexion au paiement indisponible. Réessayez sans repayer.');
$decoded = json_decode($result, true);
if (!is_array($decoded) || json_last_error() !== JSON_ERROR_NONE) fail_request(502, 'Le service de paiement doit être mis à jour avant utilisation.');
http_response_code($status);
echo json_encode($decoded, JSON_UNESCAPED_UNICODE);
