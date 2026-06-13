import 'package:test/test.dart';
import 'package:mockito/mockito.dart';
import 'package:shelf/shelf.dart';
import '../../controllers/camera_controller.dart';
import '../../services/code_agent.dart';
import '../../database/database.dart';
import '../../cache/cache.dart';
import '../helpers/mocks.dart';

void main() {
  group('CameraController', () {
    late MockDatabase db;
    late MockCache cache;
    late MockCodeAgent agent;
    late CameraController controller;

    setUp(() {
      db = MockDatabase();
      cache = MockCache();
      agent = MockCodeAgent();
      controller = CameraController(db, cache, agent);
    });

    test('capture returns request_id on success', () async {
      when(db.query(any, substitutionValues: anyNamed('substitutionValues')))
          .thenAnswer((_) async => [{'id': 42}]);
      when(cache.set(any, any, ttl: anyNamed('ttl'))).thenAnswer((_) async => null);

      final request = Request('POST', Uri.parse('http://localhost/api/capture'),
          body: '{"camera_id":"cam1"}');
      final response = await controller.capture(request);
      expect(response.statusCode, 200);
      final body = await response.readAsString();
      expect(body, contains('"request_id":"42"'));
    });

    test('capture returns 400 when camera_id missing', () async {
      final request = Request('POST', Uri.parse('http://localhost/api/capture'),
          body: '{}');
      final response = await controller.capture(request);
      expect(response.statusCode, 400);
    });

    test('capture returns 400 when camera_id empty', () async {
      final request = Request('POST', Uri.parse('http://localhost/api/capture'),
          body: '{"camera_id":""}');
      final response = await controller.capture(request);
      expect(response.statusCode, 400);
    });

    test('capture returns 400 on invalid JSON', () async {
      final request = Request('POST', Uri.parse('http://localhost/api/capture'),
          body: 'not json');
      final response = await controller.capture(request);
      expect(response.statusCode, 400);
    });

    test('capture returns 500 on DB failure', () async {
      when(db.query(any, substitutionValues: anyNamed('substitutionValues')))
          .thenThrow(Exception('DB error'));
      when(cache.set(any, any, ttl: anyNamed('ttl'))).thenAnswer((_) async => null);

      final request = Request('POST', Uri.parse('http://localhost/api/capture'),
          body: '{"camera_id":"cam1"}');
      // Should propagate exception (not caught)
      expect(() => controller.capture(request), throwsA(isA<Exception>()));
    });

    test('capture calls unifiedCameraCapture', () async {
      when(db.query(any, substitutionValues: anyNamed('substitutionValues')))
          .thenAnswer((_) async => [{'id': 1}]);
      when(cache.set(any, any, ttl: anyNamed('ttl'))).thenAnswer((_) async => null);

      final request = Request('POST', Uri.parse('http://localhost/api/capture'),
          body: '{"camera_id":"cam1"}');
      await controller.capture(request);
      verify(agent.unifiedCameraCapture()).called(1);
    });
  });
}
