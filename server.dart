import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';
import 'package:shelf_io/shelf_io.dart' as shelf_io;
import 'package:logging/logging.dart';
import 'config/config.dart';
import 'database/database.dart';
import 'cache/cache.dart';
import 'services/code_agent.dart';
import 'middleware/auth.dart';
import 'middleware/rate_limiter.dart';
import 'routes/camera_routes.dart';
import 'controllers/camera_controller.dart';

Future<void> startServer() async {
  final config = Config();
  config.load();

  final db = Database();
  await db.connect();

  final cache = Cache();
  await cache.connect();

  final agent = CodeAgent();
  final controller = CameraController(db, cache, agent);

  final router = Router()
    ..mount('/', cameraRouter(controller));

  final handler = const Pipeline()
      .addMiddleware(logRequests())
      .addMiddleware(authMiddleware())
      .addMiddleware(rateLimiterMiddleware())
      .addHandler(router);

  final server = await shelf_io.serve(handler, '0.0.0.0', config.serverPort);
  Logger.root.info('Server listening on port ${server.port}');
}
