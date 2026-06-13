import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';
import 'package:logging/logging.dart';
import '../../config/config.dart';
import '../../database/database.dart';
import '../../cache/cache.dart';
import '../../services/code_agent.dart';
import '../../middleware/auth.dart';
import '../../middleware/rate_limiter.dart';
import '../../routes/camera_routes.dart';
import '../../controllers/camera_controller.dart';
import 'mocks.dart';

Handler createTestHandler({
  required Database db,
  required Cache cache,
  required CodeAgent agent,
}) {
  final controller = CameraController(db, cache, agent);
  final router = Router()
    ..mount('/', cameraRouter(controller));
  final handler = const Pipeline()
      .addMiddleware(logRequests())
      .addMiddleware(authMiddleware())
      .addMiddleware(rateLimiterMiddleware())
      .addHandler(router);
  return handler;
}
