import 'package:shelf/shelf.dart';
import '../services/code_agent.dart';
import '../database/database.dart';
import '../cache/cache.dart';
import '../models/camera_request.dart';

class CameraController {
  final Database _db;
  final Cache _cache;
  final CodeAgent _agent;

  CameraController(this._db, this._cache, this._agent);

  Future<Response> capture(Request request) async {
    // Parse body
    final body = await request.readAsString();
    final Map<String, dynamic> data;
    try {
      data = Map<String, dynamic>.from(
        (body.isNotEmpty ? jsonDecode(body) : {}) as Map,
      );
    } catch (_) {
      return Response.badRequest(body: 'Invalid JSON');
    }

    final cameraId = data['camera_id'] as String?;
    if (cameraId == null || cameraId.isEmpty) {
      return Response.badRequest(body: 'camera_id is required');
    }

    // Execute capture (stub)
    _agent.unifiedCameraCapture();

    // Insert request into DB
    final result = await _db.query(
      'INSERT INTO camera_requests (status) VALUES (\'pending\') RETURNING id',
    );
    final requestId = result.first['id'] as int;

    // Cache status
    await _cache.set('request:$requestId', 'pending', ttl: Duration(hours: 1));

    return Response.ok(
      jsonEncode({'request_id': requestId.toString()}),
      headers: {'Content-Type': 'application/json'},
    );
  }
}
